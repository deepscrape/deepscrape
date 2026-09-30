/**
 * The function's API surface — `/api` plus the two public routes — ported route
 * for route.
 *
 * This is the group where re-using the existing code matters most: the org
 * routes are ~700 lines of logic on `ReverseAPIProxy`, the machine routes are
 * `MachinesHandler` methods, and every route is gated by the same four
 * primitives Express used (`isJwtAuth`, `requirePaidAccess`,
 * `requirePermission`, plus the mount-level rate limiter).
 *
 * They are all plain `(req, res, next)` middleware, so `runChain` runs them
 * unchanged: one shared request means `req.user` set by `isJwtAuth` is what
 * `requirePaidAccess`, `requirePermission` and the handlers read, and the
 * ordering below is the same array `functions/src/infrastructure/syncaiapi.ts`
 * registered.
 */
import { Elysia } from 'elysia'
import type {
  AuthAction,
  AuthResource,
} from '../functions/src/domain/authz.domain'
import {
  anthropicAICore,
  groqAICore,
  jinaAICrawl,
  openaiAICore,
} from '../functions/src/handlers/ai_handler'
import { scrapeMiddleware } from '../functions/src/handlers/scrape'
import { webrainJobs } from '../functions/src/handlers/webrain-jobs'
import { submitContact } from '../functions/src/handlers/contact_handler'
import { statusCheck } from '../functions/src/handlers/home_handler'
import { arachnefly } from '../functions/src/handlers/machines'
import { requirePermission } from '../functions/src/infrastructure/authz.middleware'
import { ReverseAPIProxy } from '../functions/src/infrastructure/syncaiapi'
import { type BridgeContext, type ExpressMiddleware, runChain } from './bridge'
import { limitFunction } from './limiter'

const proxy = new ReverseAPIProxy()

/** Prototype methods, so the receiver has to travel with them.
 * @param {*} fn
 * @param {*} receiver
 * @return {*}
 */
const bind = <F extends (...args: never[]) => unknown>(
  fn: F,
  receiver: object,
): ExpressMiddleware => fn.bind(receiver) as unknown as ExpressMiddleware

const jwt = bind(proxy.isJwtAuth, proxy)
const paid = bind(proxy.requirePaidAccess, proxy)

/**
 * The org methods are `private` arrow properties on `ReverseAPIProxy`, which is
 * why `this.router.get("/orgs", …, this.listOrganizations)` works without a
 * bind. Only the `private` modifier is in the way here — reaching them by name
 * keeps that logic where it lives instead of forking it into the BFF.
 * @param {*} name
 * @return {*}
 */
const org = (name: string): ExpressMiddleware => {
  const fn = (proxy as unknown as Record<string, ExpressMiddleware>)[name]

  // Fail at startup, not silently: a renamed method would otherwise only show up
  // as a 500 for authenticated users.
  if (!fn) {
    throw new Error(`bff: ReverseAPIProxy has no handler "${name}"`)
  }

  return fn
}

const perm = <R extends AuthResource>(
  resource: R,
  action: AuthAction<R>,
): ExpressMiddleware =>
  requirePermission(resource, action) as unknown as ExpressMiddleware

const api = new Elysia({ name: 'api' })

/**
 * `isJwtAuth` first, matching the order `functions/src/server.ts` mounted the
 * router: the limiter sits at the mount too, but it is an Elysia handler (it
 * writes `ctx.set`), so it wraps the chain in `h` instead of living in it.
 * @param {*} items
 * @return {*}
 */
const guard = (items: ExpressMiddleware[]) => [jwt, ...items]

const h =
  (items: ExpressMiddleware[]) =>
  async (ctx: BridgeContext): Promise<Response> => {
    const blocked = await limitFunction(ctx as never)
    if (blocked) {
      return blocked
    }

    return runChain(ctx, items)
  }

// ── organizations ────────────────────────────────────────────────────────────
api.get(
  '/api/orgs',
  h(guard([perm('organization', 'read'), org('listOrganizations')])),
)
api.get(
  '/api/orgs/:orgId',
  h(guard([perm('organization', 'read'), org('getOrganization')])),
)
api.get(
  '/api/orgs/:orgId/members',
  h(guard([perm('organization', 'read'), org('listOrganizationMembers')])),
)
api.get(
  '/api/orgs/invitations/me',
  h(guard([perm('organization', 'read'), org('listMyInvitations')])),
)
api.get(
  '/api/orgs/:orgId/invitations',
  h(guard([perm('organization', 'invite'), org('listOrgInvitations')])),
)
api.post(
  '/api/orgs',
  h(guard([perm('organization', 'manage'), org('createOrganization')])),
)
api.post(
  '/api/orgs/:orgId/invitations',
  h(guard([perm('organization', 'invite'), org('createInvitation')])),
)
api.post(
  '/api/orgs/invitations/:invitationId/accept',
  h(guard([perm('organization', 'read'), org('acceptInvitation')])),
)
api.put(
  '/api/orgs/:orgId',
  h(guard([perm('organization', 'manage'), org('renameOrganization')])),
)
api.delete(
  '/api/orgs/:orgId/members/:userId',
  h(guard([perm('organization', 'manage'), org('removeOrganizationMember')])),
)

// ── AI cores ─────────────────────────────────────────────────────────────────
api.post(
  '/api/anthropic/messages',
  h(guard([paid, perm('ai', 'execute'), anthropicAICore])),
)
api.post(
  '/api/openai/chat/completions',
  h(guard([paid, perm('ai', 'execute'), openaiAICore])),
)
api.post(
  '/api/groq/chat/completions',
  h(guard([paid, perm('ai', 'execute'), groqAICore])),
)
// `scrapeMiddleware` chooses the provider (SCRAPE_PROVIDER) rather than naming one
// here, so both hosts reach the same implementation without a code change in each.
api.post('/api/crawl', h(guard([paid, perm('crawl', 'execute'), scrapeMiddleware])))

// ── the job surface ──────────────────────────────────────────────────────────
// Playground, `/operations` and crawl packs all need a job, and none of them had
// one on this host. Two path spellings are registered per operation: the one the
// client calls today (`/api/job/stream/...`) and the transposed one the old
// commented-out Express block intended (`/api/crawl/stream/job/...`), so a client
// on either spelling reaches the same handler.
//
// The two GETs stream. `toResponse` in `bridge.ts` now returns a streamed body
// whenever a handler wrote through `res.write`, because the client's SSE readers
// take their text from `partialText` and ignore a buffered final response — so
// these would 200 with nothing in them otherwise. Auth is unaffected: `runChain`
// runs `guard([...])` before the handler and returns a refusal as soon as one
// fires, so an unauthenticated call still gets a 401 rather than a 200 stream.
api.post(
  '/api/crawl/stream/job',
  h(guard([paid, perm('crawl', 'execute'), webrainJobs.multiCrawlEnqueue])),
)

api.get(
  '/api/job/stream/status/:taskId',
  h(guard([paid, perm('crawl', 'execute'), webrainJobs.getTaskStatus])),
)
api.get(
  '/api/crawl/stream/job/status/:taskId',
  h(guard([paid, perm('crawl', 'execute'), webrainJobs.getTaskStatus])),
)

api.get(
  '/api/job/stream/:taskId',
  h(guard([paid, perm('crawl', 'execute'), webrainJobs.streamTaskResults])),
)
api.get(
  '/api/crawl/stream/job/:taskId',
  h(guard([paid, perm('crawl', 'execute'), webrainJobs.streamTaskResults])),
)

api.put(
  '/api/job/:taskId/cancel',
  h(guard([paid, perm('crawl', 'execute'), webrainJobs.cancelTask])),
)
api.put(
  '/api/crawl/job/:tempTaskId/cancel',
  h(guard([paid, perm('crawl', 'execute'), webrainJobs.cancelTask])),
)

// `/jina/:url` keeps the URL as a single path segment, as Express did.
api.get(
  '/api/jina/:url',
  h(guard([paid, perm('ai', 'execute'), jinaAICrawl])),
)

// ── machines ─────────────────────────────────────────────────────────────────
api.get(
  '/api/machines/machine/:id',
  h(guard([paid, perm('machine', 'read'), bind(arachnefly.getMachine, arachnefly)])),
)
api.get(
  '/api/machines/check-image',
  h(
    guard([
      paid,
      perm('machine', 'read'),
      bind(arachnefly.checkImageDeployability, arachnefly),
    ]),
  ),
)
api.get(
  '/api/machines/machine/waitforstate/:machineId',
  h(
    guard([
      paid,
      perm('machine', 'read'),
      bind(arachnefly.waitForState, arachnefly),
    ]),
  ),
)
api.post(
  '/api/machines/deploy',
  h(
    guard([
      paid,
      perm('machine', 'deploy'),
      bind(arachnefly.deployMachine, arachnefly),
    ]),
  ),
)

// Running a task mutates a live machine, so it takes the same `update` action
// its start/stop/suspend siblings use — the authz `machine` resource has no
// `execute` action and inventing one would mean a policy migration.
api.post(
  '/api/machines/execute-task/:machineId',
  h(
    guard([
      paid,
      perm('machine', 'update'),
      bind(arachnefly.executeTask, arachnefly),
    ]),
  ),
)
api.put(
  '/api/machines/machine/:machineId/start',
  h(
    guard([
      paid,
      perm('machine', 'update'),
      bind(arachnefly.startMachine, arachnefly),
    ]),
  ),
)
api.put(
  '/api/machines/machine/:machineId/suspend',
  h(
    guard([
      paid,
      perm('machine', 'update'),
      bind(arachnefly.suspendMachine, arachnefly),
    ]),
  ),
)
api.put(
  '/api/machines/machine/:machineId/stop',
  h(
    guard([
      paid,
      perm('machine', 'update'),
      bind(arachnefly.stopMachine, arachnefly),
    ]),
  ),
)
api.delete(
  '/api/machines/machine/:machineId',
  h(
    guard([
      paid,
      perm('machine', 'delete'),
      bind(arachnefly.destroyMachine, arachnefly),
    ]),
  ),
)

// ── public routes ────────────────────────────────────────────────────────────
// These two sit outside `/api` in the function and bypass CSRF, so without them
// they fell through to the CSR-shell catch-all: `/status` answered HTML and a
// POST to `/services/contact` answered a page instead of accepting the form.
// `h([handler])` is the same limiter + bridge as everything above — a chain of
// one needs no second mechanism.
api.get('/status', h([statusCheck]))
api.post('/services/contact', h([submitContact]))

export { api, proxy }
