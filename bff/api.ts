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
import type { ProviderKeyId } from '../functions/src/domain/user-ai-settings.domain'
import {
  anthropicAICore,
  chatCompletionsCore,
  customChatCompletionsCore,
  jinaAICrawl,
  modelsCore,
} from '../functions/src/handlers/ai_handler'
import { scrapeMiddleware } from '../functions/src/handlers/scrape'
import { webrainSerp } from '../functions/src/handlers/serp'
import {
  webrainBatch,
  webrainDownload,
  webrainExtract,
  webrainGuide,
  webrainNavigate,
  webrainObserve,
  webrainPdf,
  webrainScrape,
  webrainSearch,
  webrainSpider,
  webrainVault,
  webrainVision,
  webrainWatch,
} from '../functions/src/handlers/webrain-tools'
import { browserVault } from '../functions/src/handlers/vault'
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
  storageDelete,
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
  browserSessionFrame,
  browserSessionKeepalive,
  browserSessionList,
  browserSessionTool,
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
import { getEgress, setEgress } from '../functions/src/handlers/egress'
import { pricingEstimate, pricingRates } from '../functions/src/handlers/pricing'
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
 * Paid, OR free with the caller's own key for that provider.
 *
 * A factory rather than a flat middleware because the provider is a property of the ROUTE, and
 * the guard has to know which field of the caller's key document to look for.
 *
 * Typed on `ProviderKeyId`, not `AiVendorId`: `/api/jina/:url` is one of its callers, and jina
 * is a scrape provider. Keying this factory by the AI union is what once required a reader to be
 * listed as a chat vendor. The paid path is delegated inside `requirePaidAccess`, so pricing and
 * credit reservation stay in one place instead of being restated per route.
 * @param {*} vendor
 * @return {*}
 */
const paidOrByok = (vendor: ProviderKeyId): ExpressMiddleware =>
  proxy.requirePaidOrByok(vendor) as unknown as ExpressMiddleware

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
// `paidOrByok`, not `paid`: these are the routes a caller can pay for with their own
// vendor key, so a free account that stored one is admitted. Everything downstream is
// unchanged -- the price is still charged to a paid caller, and `keyFor` refuses the
// platform fallback for a free one, so the platform never pays for a plan that does
// not include it. `/api/crawl` stays on `paid`: there is no BYOK equivalent for the
// scraper, so a key from another vendor must not unlock it.
api.post(
  '/api/anthropic/messages',
  h(guard([paidOrByok('anthropic'), perm('ai', 'execute'), anthropicAICore])),
)
// One registration per vendor, spelled out rather than generated from the wire table: the
// route-parity gate reads these literals, and a loop would hide seven routes from it.
//
// `paidOrByok` for all of them, including the BYOK-only five. For those the guard now
// requires the caller's own key even on a paid plan, because there is no platform key for
// it to spend -- so a plan upgrade cannot buy a request that would 401 at the vendor.
api.post(
  '/api/openai/chat/completions',
  h(guard([paidOrByok('openai'), perm('ai', 'execute'), chatCompletionsCore('openai')])),
)
api.post(
  '/api/groq/chat/completions',
  h(guard([paidOrByok('groq'), perm('ai', 'execute'), chatCompletionsCore('groq')])),
)
api.post(
  '/api/deepseek/chat/completions',
  h(guard([paidOrByok('deepseek'), perm('ai', 'execute'), chatCompletionsCore('deepseek')])),
)
api.post(
  '/api/fireworks/chat/completions',
  h(guard([paidOrByok('fireworks'), perm('ai', 'execute'), chatCompletionsCore('fireworks')])),
)
api.post(
  '/api/qwen/chat/completions',
  h(guard([paidOrByok('qwen'), perm('ai', 'execute'), chatCompletionsCore('qwen')])),
)
api.post(
  '/api/kimi/chat/completions',
  h(guard([paidOrByok('kimi'), perm('ai', 'execute'), chatCompletionsCore('kimi')])),
)
api.post(
  '/api/openrouter/chat/completions',
  h(guard([paidOrByok('openrouter'), perm('ai', 'execute'), chatCompletionsCore('openrouter')])),
)
api.post(
  '/api/gemini/chat/completions',
  h(guard([paidOrByok('gemini'), perm('ai', 'execute'), chatCompletionsCore('gemini')])),
)
// The caller's own endpoint and key. Nothing is platform-supplied for this vendor, so a
// stored key is the only way in and `paidOrByok` admits a free caller who has one.
api.post(
  '/api/custom/chat/completions',
  h(guard([paidOrByok('custom'), perm('ai', 'execute'), customChatCompletionsCore])),
)
// The model catalogue, one dynamic route for every vendor.
//
// Deliberately NOT behind `paidOrByok`: a caller who has not added a key yet still needs
// to see what a vendor offers before deciding to bring one, and the handler answers an
// empty list instead of spending anything when it has no usable key. The vendor is
// validated in the handler, so a path that names a vendor we do not know is a 404 rather
// than an outbound request.
api.get(
  '/api/models/:vendor',
  h(guard([perm('ai', 'execute'), modelsCore])),
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

// The worker's own decision guide. FREE like the six above, and the only one
// that starts no browser: it answers from the binary's documentation, so the
// shared pool serves it. It is the tool whose own description says to call it
// FIRST when unsure, which makes it the cheapest thing here to expose.
api.post(
  '/api/guide',
  h(guard([access, perm('crawl', 'execute'), webrainGuide])),
)

// `paid`, for the reason `/api/vision` gives and one more.
//
// The first: these two ARE the browser escalation. `/api/scrape` is plain HTTP
// and reports `needs_js` when a page rendered nothing, so until these existed
// that signal named a remedy no caller could reach. A free caller who wants a
// browser is being sold one, so a 402 is the right answer rather than a 502.
//
// The second: both are in `SHARED_UNSAFE_TOOLS`, so `needsExclusiveWorker`
// refuses them on the single unleased `WEBRAIN_MCP_URL` and serves them only
// from a pooled lease. `navigate` CREATES the current page and `observe` reads
// it; neither is safe on a process another tenant is in.
api.post(
  '/api/navigate',
  h(guard([paid, perm('crawl', 'execute'), webrainNavigate])),
)
api.post(
  '/api/observe',
  h(guard([paid, perm('crawl', 'execute'), webrainObserve])),
)

// The four CAPACITY tools the worker advertises and nothing routed.
//
// `webrain_batch`, `webrain_crawl`, `webrain_download` and `webrain_watch` were
// all named in `PAID_ONLY_TOOLS` and reachable from no route at all, so
// `decideWebrainTool` was never asked about them and the chat could not call
// any of them. The tier table was right; it simply had nothing to gate.
//
// `batch` and `crawl` are also in `EXCLUSIVE_PAID_TOOLS`, so
// `needsExclusiveWorker` refuses both on the single unleased `WEBRAIN_MCP_URL`
// and serves them only from a pooled lease -- the existing answer for a
// capacity tool, because multi-target and spider calls would otherwise let one
// tenant exhaust a pool everyone else queues behind. These two therefore answer
// a refusal until an exclusive pool exists. The door is built and locked on
// purpose: opening it is the pool's job, not a route's.
//
// `/api/spider` and not `/api/crawl`: the latter is already
// `scrapeMiddleware`'s provider-abstracted scrape endpoint, which is a
// different tool with a different contract.
api.post(
  '/api/batch',
  h(guard([paid, perm('crawl', 'execute'), webrainBatch])),
)
api.post(
  '/api/spider',
  h(guard([paid, perm('crawl', 'execute'), webrainSpider])),
)
api.post(
  '/api/download',
  h(guard([paid, perm('crawl', 'execute'), webrainDownload])),
)
api.post(
  '/api/watch',
  h(guard([paid, perm('crawl', 'execute'), webrainWatch])),
)

// `POST /api/vision` was never registered, while the tools panel and
// `webrainTools.vision()` have called it since they landed -- so the Vision tab
// answered 404 for every caller, paid ones included. `bff/api.spec.ts` had it in
// its route table and was red on this one line, which is the only reason it is
// visible at all.
//
// `paid`, unlike the five above it, and the client already says so: the tools
// panel keys its upgrade prompt off this route's 402. `webrain_vision` is in
// `PAID_ONLY_TOOLS` as well, so the allowlist refuses a free caller a second
// time if this guard is ever loosened -- the answer that matters is the 402,
// because the remedy for a free caller here is an upgrade, not a retry.
api.post(
  '/api/vision',
  h(guard([paid, perm('crawl', 'execute'), webrainVision])),
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

// The live view. The ONLY route on this surface that answers something other
// than JSON -- a PNG -- so the content type is set by the handler rather than by
// the envelope, and a client reads it as an image and not as data.
//
// `access` plus the crawl permission, matching its four neighbours: a free caller
// has no session to view (`SESSION_CAPS.free.dedicated` is 0), so a plan refusal
// here would answer 402 about a machine that was never leased. The tier still
// matters and is read by the handler for the fps cap.
//
// Owner scope is the handler's, and it is the first thing it does: a foreign
// session id is a 404 before any machine is asked for a screenshot.
api.get(
  '/api/browser/session/:id/frame',
  h(guard([access, perm('crawl', 'execute'), browserSessionFrame])),
)
// The write half of the same join. `frame` reads the session's own machine; this
// drives it. Same guard, same owner-scoped 404, and the same refusal to touch the
// shared pool -- which is what makes it safe for a tool like `webrain_interact`
// that the pool refuses on purpose. The handler refuses any tool outside
// `SESSION_TOOLS` and names the allowed set in the response.
api.post(
  '/api/browser/session/:id/tool',
  h(guard([access, perm('crawl', 'execute'), browserSessionTool])),
)

// The credential vault: `access`, like its four neighbours, and the tier
// boundary lives in the handler instead of in this guard.
//
// It used to carry `paid`, which made the whole route a 402 for a free caller.
// That is the wrong place for the decision once the ops differ from each other:
// only the handler knows the `op` and whether the caller named a browser of
// their own, and the cookie pair is safe for any tier when they did -- the jar
// travels in the request and the browser is theirs, so no platform worker keeps
// anything (`isEndpointCookieCall`). Every other op on this route still refuses
// a non-admin, for the reason `VAULT_TOOLS` gives: the worker's vault is
// process-global, so a stored profile outlives the lease that wrote it. 402 is
// still the answer a caller sees when a route is genuinely paid; this one now
// answers 403 with the specific reason.
api.post(
  '/api/browser/session/vault',
  h(guard([access, perm('crawl', 'execute'), webrainVault])),
)

// The durable vault: the platform's own storage for a cookie jar, so a profile
// outlives the machine it was captured on (`handlers/vault.ts`).
//
// A DIFFERENT route from `/api/browser/session/vault` above, and the difference
// is which side owns the bytes. That one drives the WORKER's vault ops, which
// need a browser and are refused for non-admins; this one only stores, reads,
// lists and forgets what a caller hands it, so it needs no worker, no session
// and no endpoint. `access`, not `paid`, because the thing being bounded is
// abuse (`VAULT_MAX_ENTRIES`) rather than the caller's plan -- and the published
// claim about profiles does not name a tier.
api.post(
  '/api/browser/vault',
  h(guard([access, perm('crawl', 'execute'), browserVault])),
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

// What the NEXT call costs THIS caller, and the reason `access` is not optional
// here: the handler reads `req.accessMode`, which only `resolveAccess` sets. Drop
// it and every caller is priced as `free`, so a paid account would be told its
// next call costs nothing -- the estimate would agree with a charge it does not
// predict, which is worse than refusing to answer.
//
// Still no `perm(...)`, and `access` rather than `paid`, for the same reason as
// the rate list above: this quotes a price to someone deciding whether to buy.
// The question is about THEIR next call, so unlike `rates` the answer is not the
// same for everyone -- `credits` is the table's and `effectiveCredits` is theirs.
//
// `method` and `path` are query params naming the call being priced. No `count`:
// the charge is flat per request, so a multiplier would quote a number the
// platform never takes.
api.get('/api/pricing/estimate', h(guard([access, pricingEstimate])))

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

// ── the caller's OWN egress proxy ────────────────────────────────────────────
// The counterpart to `/api/webrain/config/proxies`, which is the PLATFORM's pool
// and is consequently admin-only. This one configures where ONE caller's crawls
// leave from, so the document path is derived from the verified token and there
// is no id in the URL to tamper with. Nothing here spends a credit or reads a
// billing document, so it carries no `access` -- the same reasoning the stored
// artifacts below record.
//
// The write is `crawl.execute`, and NOT a `crawl.write`, which does not exist.
// Pointing your own traffic at your own exit is at least as privileged as
// running a crawl, and it grants nothing over anybody else, so `crawl.read` is
// enough to look and `crawl.execute` is what it takes to change. Adding a
// `crawl.write` action would mean deciding who holds it, which is an entitlement
// decision rather than a route change (roadmap 12 records it as open).
api.get('/api/egress', h(guard([perm('crawl', 'read'), getEgress])))
api.put('/api/egress', h(guard([perm('crawl', 'execute'), setEgress])))

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
// `storage.write`, not `read`: this removes an object. The scoping the other
// routes rely on still applies -- the handler answers 404 for a key the caller
// may not read, and refuses a shared key outright.
api.post(
  '/api/storage/delete',
  h(guard([perm('storage', 'write'), storageDelete])),
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
//
// `paidOrByok('jina')` because jina is a provider a caller can key themselves, NOT because it
// is an AI vendor -- it is a reader, listed in `scrape-providers.domain.ts` beside `crawl4ai`
// and `webrain`. The guard branches on that catalogue for it rather than on `AI_VENDORS`, which
// is what stopped a reader having to masquerade as a chat vendor to be reached.
//
// `perm('ai', 'execute')` stays: it is the capability every BYOK caller already holds, and
// swapping it for `crawl` would relabel the check without changing who passes it.
api.get(
  '/api/jina/:url',
  h(guard([paidOrByok('jina'), perm('ai', 'execute'), jinaAICrawl])),
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
