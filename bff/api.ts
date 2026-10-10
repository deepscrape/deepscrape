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
import { webrainSerp } from '../functions/src/handlers/serp'
import {
  webrainExtract,
  webrainPdf,
  webrainScrape,
  webrainSearch,
  webrainVault,
} from '../functions/src/handlers/webrain-tools'
import { schemaCompiler } from '../functions/src/handlers/schema-compiler'
import {
  monitorChecks,
  monitorCreate,
  monitorDelete,
  monitorList,
  monitorUpdate,
} from '../functions/src/handlers/monitors'
import {
  storageGetSettings,
  storageList,
  storagePresign,
  storageSave,
  storageSetSettings,
} from '../functions/src/handlers/storage'
import {
  recordCrawlFailure,
  runCrawlTarget,
  webrainJobs,
} from '../functions/src/handlers/webrain-jobs'
import {
  verifyQstashDelivery,
  type CrawlTargetMessage,
} from '../functions/src/infrastructure/qstash'
import { submitContact } from '../functions/src/handlers/contact_handler'
import { statusCheck } from '../functions/src/handlers/home_handler'
import { arachnefly } from '../functions/src/handlers/machines'
import {
  browserSessionClose,
  browserSessionCreate,
  browserSessionKeepalive,
  browserSessionList,
} from '../functions/src/handlers/browser-sessions'
import {
  getWebrainConfig,
  setWebrainProxies,
  setWebrainToken,
} from '../functions/src/handlers/webrain-config'
import {
  machineFleetList,
  machineListMine,
} from '../functions/src/handlers/machine-fleet'
import { sessionFleetList } from '../functions/src/handlers/session-fleet'
import {
  billingPolicyGet,
  billingPolicySet,
} from '../functions/src/handlers/billing-policy'
import { pricingRates } from '../functions/src/handlers/pricing'
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
const access = bind(proxy.resolveAccess, proxy)

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

// ── free-tier structured search ──────────────────────────────────────────────
// `access`, NOT `paid`: the per-tool tier decision belongs to
// `decideWebrainTool`'s allowlist inside the call, and `requirePaidAccess`
// would 402 a free caller before it ever resolved `req.accessMode`. The
// free/paid boundary lives in `webrain-tools.domain.ts`, deliberately.
// Scope is unchanged: `guard` still prepends `jwt`, and this still passes
// `crawl.execute`, which `self` already grants.
api.post(
  '/api/serp',
  h(guard([access, perm('crawl', 'execute'), webrainSerp])),
)

// The other four free-tier webrain routes. Identical guard to `/api/serp` and
// for the same reason: `access` resolves `req.accessMode` for a free caller
// without 402-ing it, and the per-tool decision stays in
// `decideWebrainTool`'s allowlist. Each handler refuses the arguments the
// worker does not take (`limit` on search, `url` on extract/pdf) with a 400.
api.post(
  '/api/scrape',
  h(guard([access, perm('crawl', 'execute'), webrainScrape])),
)
api.post(
  '/api/search',
  h(guard([access, perm('crawl', 'execute'), webrainSearch])),
)
api.post(
  '/api/extract',
  h(guard([access, perm('crawl', 'execute'), webrainExtract])),
)
api.post(
  '/api/pdf',
  h(guard([access, perm('crawl', 'execute'), webrainPdf])),
)

// The schema compiler: turn a sentence into a schema a caller can reuse.
//
// Free-resolving like the five above -- `access`, not `paid` -- deliberately:
// the whole point is that a caller who cannot write a `base_selector` still
// gets structured data, and a 402 would put the feature behind exactly the
// skill it exists to remove. It DOES spend one model call on the platform's
// key, so the ceiling here is cost, not confidentiality: it is unmetered today,
// bounded by the BFF rate limiter and a ~6KB prompt. Meter it (one credit per
// compile, like a crawl) or move it to `paid` when free-tier spend matters --
// see the header of `handlers/schema-compiler.ts`.
api.post(
  '/api/extract/schema',
  h(guard([access, perm('crawl', 'execute'), schemaCompiler])),
)

// ── monitors ─────────────────────────────────────────────────────────────────
// Free-resolving, like the five above: a monitor is one bounded, infrequent
// read of one page, and `paid` would 402 a free caller before `req.accessMode`
// existed. `MONITOR_MAX_PER_USER` is what bounds a free account here, enforced
// in the handler, because the resource being protected is the shared worker
// pool rather than revenue.
//
// Every handler scopes to `req.user.uid` and the store refuses a monitor whose
// stored `uid` differs, so the id in these bodies is an address and never a
// credential.
api.get(
  '/api/monitor/list',
  h(guard([access, perm('crawl', 'execute'), monitorList])),
)
api.get(
  '/api/monitor/checks',
  h(guard([access, perm('crawl', 'execute'), monitorChecks])),
)
api.post(
  '/api/monitor/create',
  h(guard([access, perm('crawl', 'execute'), monitorCreate])),
)
api.post(
  '/api/monitor/update',
  h(guard([access, perm('crawl', 'execute'), monitorUpdate])),
)
api.post(
  '/api/monitor/delete',
  h(guard([access, perm('crawl', 'execute'), monitorDelete])),
)

// ── browser sessions ────────────────────────────────────────────────────────
// `access`, not `paid`, for the same reason the monitor routes use it: free is
// not "not entitled to ask" — `SESSION_CAPS.free` is zero across the board, so
// `decideLease` has a real, named answer to give. Gating on the billing mode
// would 402 a free caller before the domain saw the request, and the 402 says
// nothing about which limit they hit.
//
// Scope is unchanged and comes from `perm(...)`; every handler takes the uid
// from the VERIFIED token and the store reads only that caller's subcollection,
// so a foreign session id is an address that answers 404.
//
// §1.2's routes. Metering is deliberately not here — see §1.6.
api.get(
  '/api/browser/session',
  h(guard([access, perm('crawl', 'execute'), browserSessionList])),
)
api.post(
  '/api/browser/session',
  h(guard([access, perm('crawl', 'execute'), browserSessionCreate])),
)
api.post(
  '/api/browser/session/:id/keepalive',
  h(guard([access, perm('crawl', 'execute'), browserSessionKeepalive])),
)
api.post(
  '/api/browser/session/:id/close',
  h(guard([access, perm('crawl', 'execute'), browserSessionClose])),
)

// The credential vault: the one `paid` route in the browser-session family.
//
// `paid`, where its four neighbours carry `access`, and the difference is the
// point rather than an inconsistency. Those four are not a confidentiality
// problem -- a free caller's session caps are simply zero -- so a 402 in front
// of them would refuse a caller who is entitled to ask. The vault is different
// twice over: `VAULT_TOOLS` in `webrain-tools.domain.ts` puts these ops behind a
// paid tier, and the vault is PROCESS-GLOBAL on the worker, so a free caller
// would be listing and replaying credentials it does not own. 402 is the honest
// answer, and it is what the UI keys its upgrade prompt off rather than
// guessing at the caller's plan client-side.
api.post(
  '/api/browser/session/vault',
  h(guard([paid, perm('crawl', 'execute'), webrainVault])),
)

// ── pricing ──────────────────────────────────────────────────────────────────
// `access` and NOT `paid`: a customer deciding whether to buy must be able to see
// what things cost, so gating the price list behind payment would hide the very
// page that answers the question. `access` still resolves the plan, which is what
// lets the response be the same for everyone: the rates are the table's, not the
// caller's.
//
// No `perm(...)`: this reads no customer data and exposes no action. What it
// exposes is our PUBLIC price list, projected from the same table the charging
// path uses, so the page cannot advertise a number the code does not honour.
api.get('/api/pricing/rates', h(guard([access, pricingRates])))

// ── the customer's spend cap ─────────────────────────────────────────────────
// `access` and not `paid`: a free-tier customer is exactly the one most likely
// to want a ceiling, and the document is their own. No `perm(...)` -- the uid
// comes from the verified token, so this reads and writes one caller's document
// and exposes no action on anyone else's.
//
// PUT rather than POST because the body is MERGED into the stored policy, so
// sending it twice leaves the same document. That is what makes a retry safe,
// and it is also why there is no DELETE: clearing a cap is `spendCapCredits: 0`.
api.get('/api/billing/policy', h(guard([access, billingPolicyGet])))
api.put('/api/billing/policy', h(guard([access, billingPolicySet])))

// ── stored artifacts ─────────────────────────────────────────────────────────
// Deliberately WITHOUT `paid` or `access`: this surface spends no credits and
// reads no billing document, so it must not require an entitlement to resolve.
// The gate is `storage.read` / `storage.write`, granted to `self` only -- and
// `requirePermission` derives ownerId from the VERIFIED token, so one caller's
// objects never appear in another caller's list.
//
// Nothing about the shared-vs-user decision is duplicated here. It is made once
// in `functions/src/domain/storage-scope.domain.ts` and applied by the handler,
// which returns the chosen scope in the response.
api.get(
  '/api/storage/list',
  h(guard([perm('storage', 'read'), storageList])),
)
api.get(
  '/api/storage/settings',
  h(guard([perm('storage', 'read'), storageGetSettings])),
)
api.post(
  '/api/storage/save',
  h(guard([perm('storage', 'write'), storageSave])),
)
api.post(
  '/api/storage/presign',
  h(guard([perm('storage', 'read'), storagePresign])),
)
api.post(
  '/api/storage/settings',
  h(guard([perm('storage', 'write'), storageSetSettings])),
)

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

// The seeder's enqueue. Status, results and cancel are the SAME routes as the
// crawl job's — the client rewrites `/seeder` to `/job` for all three — so only
// the enqueue path needs its own registration, to accept `domains` rather than
// `urls`.
api.post(
  '/api/seeder/stream/job/multi-research',
  h(guard([paid, perm('crawl', 'execute'), webrainJobs.multiSeedEnqueue])),
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

// ── the queue's delivery endpoints ───────────────────────────────────────────
// Not `h(guard([...]))`: QStash cannot present a Firebase JWT, so the signature
// IS the authentication. These are also the only routes here that are
// machine-only, which is why they read the request directly instead of entering
// the Express bridge — the signature covers the exact bytes, and the bridge has
// no notion of an unparsed body.
//
// No rate limiter in front either: the enqueue route is where a user acts, and
// throttling a delivery turns a retry into a failure.

/** The raw body, or null when the delivery is not signed by QStash. */
const signed = async (request: Request): Promise<string | null> => {
  const raw = await request.text()
  const signature = request.headers.get('upstash-signature') ?? ''

  return (await verifyQstashDelivery(raw, signature, request.url)) ? raw : null
}

api.post('/api/jobs/crawl/worker', async ({ request, set }) => {
  const raw = await signed(request)
  if (raw === null) {
    set.status = 401
    return { error: 'Invalid signature' }
  }

  const message = JSON.parse(raw) as CrawlTargetMessage

  try {
    await runCrawlTarget(
      message.uid,
      message.taskId,
      message.url,
      message.accessMode,
    )
  } catch {
    // 5xx is what makes QStash retry. A 4xx would retire the message instead,
    // and a transient worker outage would become a permanent result.
    set.status = 502
    return { retry: true }
  }

  return { ok: true }
})

api.post('/api/jobs/crawl/failed', async ({ request, set }) => {
  const raw = await signed(request)
  if (raw === null) {
    set.status = 401
    return { error: 'Invalid signature' }
  }

  const message = JSON.parse(raw) as CrawlTargetMessage
  await recordCrawlFailure(
    message.uid,
    message.taskId,
    message.url,
    'No result after the retries were exhausted',
  )

  return { ok: true }
})

// `/jina/:url` keeps the URL as a single path segment, as Express did.
api.get(
  '/api/jina/:url',
  h(guard([paid, perm('ai', 'execute'), jinaAICrawl])),
)

// ── machines ─────────────────────────────────────────────────────────────────
// The caller's OWN machines, tenant-scoped, and the only route here that reads
// this platform's Firestore rather than forwarding to arachnefly. The uid comes
// from the verified token inside the handler, so there is no input that could
// widen the scope to another tenant.
//
// `machine.read` is the right gate and it is safe HERE precisely because the
// scope is the caller. The same permission on the PLATFORM-wide fleet would hand
// every paid customer a list of every tenant's machines, which is why that one
// takes `platform` instead. Same word, two different gates, and the difference is
// the scope, not the permission name.
//
// Every machine is marked `kind` (container or browser-session) because the two
// are NOT interchangeable to act on: a session's machine is released by the
// session's close route, and destroying it directly leaves a session record
// billing for a machine that no longer exists.
api.get('/api/machines', h(guard([paid, perm('machine', 'read'), machineListMine])))
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

// ── the webrain configuration (platform admin only) ──────────────────────────
// `perm('platform', ...)` IS the admin gate: no role in `POLICIES` is granted
// `platform`, so only the platform-admin short-circuit in `canPerform` admits a
// caller. `guard` still prepends `jwt`, so an unauthenticated call is a 401
// before the permission layer ever runs. No `paid`: this surface spends no
// credits, it rotates a credential the platform owns.
api.get(
  '/api/webrain/config',
  h(guard([perm('platform', 'read'), getWebrainConfig])),
)
api.post(
  '/api/webrain/config/token',
  h(guard([perm('platform', 'write'), setWebrainToken])),
)
api.post(
  '/api/webrain/config/proxies',
  h(guard([perm('platform', 'write'), setWebrainProxies])),
)

// ── the machine fleet (platform admin only) ──────────────────────────────────
// `perm('platform', 'read')` and NOT `perm('machine', 'read')`. The machine
// permission is tenant-scoped and every paid customer holds it, so gating a
// cross-tenant listing on it would hand every paid user a list of every tenant's
// machines. `platform` is granted to no role in `POLICIES`; only the
// `isPlatformAdmin` short-circuit in `canPerform` admits it.
//
// Read-only on purpose. The per-machine ACTIONS (start, suspend, stop, destroy)
// stay on their own tenant routes, because arachnefly's `MachineOwnershipMiddleware`
// admits only the machine's owner and has no admin bypass. An action route here
// would have to forward another tenant's uid, which is an authorization change in
// a live service and is not made silently.
api.get(
  '/api/admin/machines',
  h(guard([perm('platform', 'read'), machineFleetList])),
)

// The session fleet: every live browser session, platform-wide.
//
// Identical gate to the fleet route above, and for the same reason rather than
// by habit: `platform` is granted to NO role in `POLICIES`, so only the
// `isPlatformAdmin` short-circuit admits it. `crawl.execute` -- held by every
// paid customer -- would hand every paying tenant a live view of every other
// tenant's browser activity.
//
// Read-only. Reclaim is deliberately absent: it moves the idle deadline the Go
// reaper reads, which suspends a customer's live, still-billing machine. That
// needs the same sign-off the fleet's lifecycle actions do -- see the handler.
api.get(
  '/api/admin/sessions',
  h(guard([perm('platform', 'read'), sessionFleetList])),
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
