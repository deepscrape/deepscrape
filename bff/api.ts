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
  crawl4aiCore,
  groqAICore,
  jinaAICrawl,
  openaiAICore,
} from '../functions/src/handlers/ai_handler'
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
api.post('/api/crawl', h(guard([paid, perm('crawl', 'execute'), crawl4aiCore])))

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
