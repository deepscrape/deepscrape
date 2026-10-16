/* eslint-disable object-curly-spacing */
/**
 * Which webrain tools a caller may use, by plan.
 *
 * Why this file is load-bearing
 * -----------------------------
 * webrain's own `WEBRAIN_NO_STATE=1` is NOT a tenancy boundary. Verified
 * against a
 * running worker: it refuses exactly `webrain_profiles`, `webrain_launch` and
 * `webrain_login`, while `webrain_session(op=list)` is served on a shared
 * instance. On a shared pool that means one tenant can enumerate another's
 * sessions. The worker cannot be made to enforce this without forking it, and
 * the
 * decision of record is to escalate upstream rather than fork — so the boundary
 * has to exist HERE, in front of the worker.
 *
 * Allowlist, not denylist
 * -----------------------
 * Default-deny is the whole point. A denylist of "stateful tools" fails open
 * the
 * day webrain ships a tool nobody anticipated, and shipping a new tool is a
 * routine
 * upstream event. An allowlist fails closed, and the cost is one line per new
 * tool
 * we decide to expose — friction in the correct direction.
 *
 * What is deliberately NOT here
 * ----------------------------
 * No op-level filtering. `webrain_session(op=list)` is the observed hole, but
 * filtering ops would mean modelling another service's parameter space, which
 * is
 * exactly the coupling the plan rejects. The tool is either in a tier's set or
 * it
 * is not.
 */
import { isPaidAccess } from "./scrape-providers.domain"

/** The tier a call runs at, derived from the request's access mode. */
export type WebrainTier = "free" | "paid" | "admin"

/**
 * Tools the SHARED pool may serve.
 *
 * Stateless reads only: one call, one answer, nothing held between calls. These
 * are the tools whose cost is a CPU burst plus egress, which is what a shared
 * container can absorb for many tenants.
 *
 * `webrain_download` and `webrain_watch` were REMOVED from this set. Their cost
 * is bandwidth and CPU proportional to the payload -- ytdlp transfer, and
 * inbound video turned into frames -- which is not the CPU burst this docstring
 * describes. No route exposed either one, so nothing broke; but the next
 * `/api/download` added with the free guard would have handed every free tenant
 * ytdlp on the platform's bandwidth. Cost that scales with payload gets
 * metered, which is the entire reason these two sets exist.
 */
export const SHARED_POOL_TOOLS: readonly string[] = [
  "webrain_guide",
  "webrain_scrape",
  "webrain_search",
  "webrain_serp",
  "webrain_extract",
  "webrain_pdf",
]

/**
 * Tools added for a PAID tier, on top of the shared set.
 *
 * Two different reasons live here and both are deliberate:
 *
 * - `session` / `profiles` / `launch` / `login` hold state ACROSS calls, so
 * they
 *    are only safe on a leased container — that is the paid entitlement.
 * - `crawl` / `batch` / `navigate` / `interact` are not a confidentiality
 * problem
 * at all; they are a CAPACITY one. Multi-target and browser-driving calls would
 * let one free tenant exhaust a shared pool that everyone else is queued
 * behind.
 */
export const PAID_ONLY_TOOLS: readonly string[] = [
  "webrain_session",
  "webrain_profiles",
  "webrain_launch",
  "webrain_login",
  "webrain_navigate",
  "webrain_observe",
  "webrain_interact",
  "webrain_crawl",
  "webrain_batch",
  "webrain_vision",
  "webrain_eval",
  "webrain_eval_in_frame",
  // Moved here from the shared set: they are payload-heavy, not
  // capacity-heavy -- one call moves unbounded bytes, so the cost is the
  // transfer rather than the concurrency. No route exposes either today,
  // so no caller's answer changes.
  "webrain_download",
  "webrain_watch",
]

/**
 * Tools that read "the current page" and so need a worker of their own.
 *
 * `webrain_extract` returns "structured extraction from the CURRENT page" and
 * `webrain_pdf(op=page)` saves the current page as a PDF. Neither takes a URL,
 * so on a shared process "the current page" is whatever the previous caller
 * left there -- which means a free caller can read a page another tenant
 * fetched, and a paid one cannot. That is not a gap in the tier sets above; it
 * is a gap in what a SHARED process can attribute to anybody.
 *
 * They stay in `SHARED_POOL_TOOLS` deliberately, so this list is a SUBSET of it:
 * a second axis ON the shared tier rather than a tier of its own. The spec pins
 * that. What they need is not a tier, it is exclusivity: on a LEASED worker the
 * caller owns the current page and both tools are correct, for a free caller as
 * much as for a paid one. So it is checked where the worker is known rather than
 * where the tier is -- see `webrainTool`.
 *
 * The PAID tools needing the same exclusivity are in `EXCLUSIVE_PAID_TOOLS`
 * below, kept separate precisely so this one keeps the subset contract.
 *
 * Verified: `WEBRAIN_NO_STATE` does NOT cover either of these. It refuses
 * exactly `profiles`, `launch` and `login`. The shared-worker guard therefore
 * cannot come from webrain and has to exist here, which is the same conclusion
 * this file's header reaches about the tenancy boundary itself.
 */
export const SHARED_UNSAFE_TOOLS: readonly string[] = [
  "webrain_extract",
  "webrain_pdf",
]

/**
 * PAID tools that need an exclusive worker for the same reason.
 *
 * A separate list because `SHARED_UNSAFE_TOOLS` is asserted to be a subset of
 * `SHARED_POOL_TOOLS`, and every tool here is in `PAID_ONLY_TOOLS` instead: they
 * are browser or capacity tools first, which is what makes them paid, and page
 * tools second.
 *
 * Two ways they reach a page another caller left:
 *
 * - `webrain_navigate` CREATES the current page, and `webrain_observe` then
 *   reads whichever one the previous caller left there.
 * - `webrain_batch` opens concurrent tabs and `webrain_crawl` starts a spider,
 *   which contend with whatever else holds the worker.
 *
 * Without this list a paid caller would run any of them on the single unleased
 * `WEBRAIN_MCP_URL` and read a page the previous caller fetched -- the same
 * disclosure `SHARED_UNSAFE_TOOLS` prevents, one tier up.
 *
 * `webrain_interact` is listed although no route exposes it yet: listing it is
 * one line and makes the first `/api/interact` fail closed, where omitting it
 * would make that route a shared-process browser driver by default.
 *
 * `webrain_download` and `webrain_watch` joined this list on 2026-10-16 for a
 * DIFFERENT reason, and it is worth separating from the two above.
 *
 * Neither reads a page, so the disclosure the first five prevent does not
 * apply. What they do is WRITE, to a path they share with every other tenant on
 * the worker. `download_files` computes `{dir}/{index}_{name}` with `dir`
 * defaulting to the relative `"downloads"`, and then returns that PATH as
 * `BatchResult.title` with `data: None` -- so two tenants fetching
 * `.../0/photo.jpg` mint the SAME `downloads/0_photo.jpg` and the second
 * silently overwrites the first. The copy is also unbounded (`io::copy` has no
 * cap), which is a disk-fill on a process everybody else is queued behind.
 * `watch_from_args` takes an `out_dir` and can run for minutes.
 *
 * The read chain is NOT open, and this is why the fix is narrow: the only tool
 * that reads a worker-side path is `webrain_pdf`, and it is in
 * `SHARED_UNSAFE_TOOLS`, so it is already refused on the shared pool. A
 * downloads, B cannot extract. So this is a data-loss and resource problem
 * rather than a leak -- but it is still a reason a shared process must not
 * serve either tool.
 *
 * `webrain_guide` is in NEITHER list. It answers from the binary's own
 * documentation, touches no page, and holds no state, which is why the shared
 * pool serves it.
 */
export const EXCLUSIVE_PAID_TOOLS: readonly string[] = [
  "webrain_navigate",
  "webrain_observe",
  "webrain_interact",
  "webrain_batch",
  "webrain_crawl",
  "webrain_download",
  "webrain_watch",
]

/**
 * Whether a tool touches page state a shared worker cannot attribute to one
 * caller.
 *
 * One predicate over two lists, because the call site asks one question: may
 * this run on a worker somebody else may be in? The lists are split by TIER
 * membership rather than by the answer, which is why the answer is an OR.
 * @param {unknown} name The tool name as the caller supplied it.
 * @return {boolean} True when the tool needs an exclusive worker.
 */
export const needsExclusiveWorker = (name: unknown): boolean =>
  typeof name === "string" &&
  (SHARED_UNSAFE_TOOLS.includes(name) ||
    EXCLUSIVE_PAID_TOOLS.includes(name))

/**
 * The tools a caller may run on their OWN leased machine.
 *
 * A named set rather than "any MCP call the client sends", and the distinction is
 * the whole safety argument. The route behind this reaches a machine leased to
 * exactly one tenant, so exclusivity -- and therefore I2 -- is satisfied by the
 * LEASE rather than by a tier allowlist: that is why the members below do not
 * have to be in `SHARED_POOL_TOOLS` to be legitimate here.
 *
 * But "the lease is the boundary" is a claim about a MACHINE, not a licence to
 * forward whatever tool name a client invents. What every member has in common is
 * `needsExclusiveWorker` returning true -- which is the property that matters: a
 * caller who reached any of them through the POOL would have needed an exclusive
 * worker anyway. The spec asserts it for every member, over the OR rather than
 * over one list, because `webrain_pdf` arrives through `SHARED_UNSAFE_TOOLS` and
 * the rest through `EXCLUSIVE_PAID_TOOLS`. Adding one is a decision, made here,
 * in one place.
 *
 * Why `webrain_batch` and `webrain_crawl` ARE here (decided 2026-10-16)
 * --------------------------------------------------------------------
 * They were absent because they are long-running, and that reason does not
 * survive contact with the meter. A leased machine is billed per started
 * 5-minute block up to a 20-credit ceiling, so duration is already the thing the
 * customer pays for -- `machineChargeFor` exists precisely because browser time
 * is per minute. A long crawl on a machine leased to ONE tenant is therefore an
 * expensive request, not an unsafe one.
 *
 * Holding them back cost more than it bought: `needsExclusiveWorker` refuses
 * both on the unleased `WEBRAIN_MCP_URL`, no pool exists, so leaving them off
 * this list made `/api/batch` and `/api/spider` doors into a wall.
 *
 * The safety argument is the one already recorded for this list -- the lease is
 * the boundary, so I2 is satisfied by the lease rather than by an allowlist --
 * and both stay in `EXCLUSIVE_PAID_TOOLS`, which is what keeps that true: a
 * caller who reaches either through the POOL still needs an exclusive worker,
 * and the spec asserts that for every member of this list.
 *
 * Why `webrain_download`, `webrain_watch` and `webrain_pdf` also belong
 * --------------------------------------------------------------------
 * `webrain_download` returns a PATH, not bytes: `download_files` writes to
 * `{dir}/{index}_{name}` with `dir` defaulting to the relative `"downloads"`, and
 * sets `BatchResult.title` to that path with `data: None`. On a machine of the
 * caller's own the file lands in THEIR container, and the only way to get its
 * CONTENT back is `webrain_pdf(op=extract, path=...)`. That is why `pdf` is
 * listed here and not left where it was: without it, download would be a route
 * handing back a path nobody can read, on any surface.
 *
 * `webrain_watch` takes an `out_dir` and shells out to yt-dlp/ffmpeg for frames,
 * so it writes and can run for minutes. `pdf` likewise reads a caller-named
 * path. All three are reads or writes against a PATH, which is what a lease
 * makes safe and a shared process does not.
 *
 * Deliberately absent, and not for tier reasons: `webrain_eval` and
 * `webrain_eval_in_frame` run arbitrary JavaScript, and `webrain_profiles`,
 * `webrain_login` and `webrain_launch` need state that outlives a machine, which
 * no machine has.
 *
 * What this list is NOT
 * ---------------------
 * The machine-direct route (`POST /api/browser/session/:id/tool`) takes the
 * caller's args RAW, because the lease is the boundary -- so it does not consult
 * the mappers in `handlers/webrain-tools.ts` at all. Those mappers narrow the
 * POOL routes (`/api/batch` refuses `op=eval` and `dir`); they are not, and must
 * not be mistaken for, a boundary on a machine the caller already owns.
 */
export const SESSION_TOOLS: readonly string[] = [
  "webrain_navigate",
  "webrain_observe",
  "webrain_interact",
  "webrain_batch",
  "webrain_crawl",
  "webrain_download",
  "webrain_watch",
  "webrain_pdf",
]

/**
 * Whether a tool may be run on a caller's own machine.
 * @param {unknown} name The tool name as the caller supplied it.
 * @return {boolean} True when `SESSION_TOOLS` lists it.
 */
export const isSessionTool = (name: unknown): boolean =>
  typeof name === "string" && SESSION_TOOLS.includes(name)

/**
 * Tools that read or write the worker's credential VAULT.
 *
 * These four are the stateful names, and they are the ones the vault belongs
 * to: `profiles` lists and edits stored logins, `login` performs one, `launch`
 * starts the browser a login needs, and `session` enumerates the sessions those
 * produce.
 *
 * Why they need the CALLER'S OWN worker, and why "exclusive" is not enough
 * ---------------------------------------------------------------------
 * webrain's vault is **process-global**, not per-session: *"The unit of tenancy
 * is the container, not the MCP session. webrain's vault and profiles are
 * process-global"* (`docs/ADR-2026-09-CRAWL-PROVIDER-ABSTRACTION.md:111`). The
 * worker pool reuses a worker across tenants. So a profile written on a POOLED
 * worker outlives the lease that wrote it and is readable by whoever leases
 * that worker next -- a credential disclosure with nothing to revoke.
 *
 * The `leased` axis does not cover this, which is the point: a pooled lease is
 * exclusive FOR THE CALL, and what persists here is the PROCESS.
 * `SHARED_UNSAFE` asks whether anyone else is in this worker right now; this
 * asks whether anything outlives my visit to it, which is a different question.
 *
 * The join now EXISTS -- `acquireWorkerTarget` takes a caller's own machine as
 * its first source, and `ownBrowserMachine` resolves it from their live lease --
 * and it deliberately does NOT satisfy this predicate. What that join offers the
 * three `SESSION_TOOLS` is a machine for the DURATION of a session, and these
 * four write to `profiles_dir()` expecting the state to still be there
 * afterwards, which no ephemeral machine provides. They therefore stay refused,
 * and this predicate is what keeps the "run it on my machine" route from quietly
 * writing a customer's credentials into a platform worker.
 */
export const VAULT_TOOLS: readonly string[] = [
  "webrain_profiles",
  "webrain_login",
  "webrain_launch",
  "webrain_session",
]

/**
 * Whether a tool touches the vault and so needs the caller's own worker.
 * @param {unknown} name The tool name as the caller supplied it.
 * @return {boolean} True when the tool must not run on a platform worker.
 */
export const needsCallerOwnWorker = (name: unknown): boolean =>
  typeof name === "string" && VAULT_TOOLS.includes(name)

/**
 * The two vault ops that move the cookie jar in the PAYLOAD.
 *
 * `cookies` reads a jar out of a browser and `setcookies` writes one into a
 * browser. Neither opens `profiles_dir()/<service>/<profile>`, which is the
 * whole difference between them and the five file-backed ops beside them in
 * `VAULT_OPS`. So there is no state to leave behind on a platform worker.
 */
export const ENDPOINT_COOKIE_OPS: readonly string[] = ["cookies", "setcookies"]

/**
 * Whether a call is one of those cookie ops AND names a browser of its own.
 *
 * The endpoint is the entire safety argument. Without one, a cookie call reads
 * or writes the jar of whatever browser the pooled worker
 * happens to hold, which
 * is a disclosure of another tenant's session -- exactly what `VAULT_TOOLS`
 * refuses. With one, the request touches a browser the caller supplied and the
 * jar travels in the request body, so a platform worker
 * keeps nothing and a free
 * caller costs nothing.
 *
 * The address itself is vetted at the trust boundary, in `vaultArguments` via
 * `cdpEndpointFrom`; this only has to notice that one was given.
 * @param {unknown} toolName The tool name as the caller supplied it.
 * @param {Record<string, unknown> | undefined} args The mapped worker arguments
 * @return {boolean} True when the call is safe on any tier.
 */
export const isEndpointCookieCall = (
  toolName: unknown,
  args: Record<string, unknown> | undefined
): boolean => {
  if (toolName !== "webrain_session" || !args) {
    return false
  }

  const op = args["op"]
  if (
    typeof op !== "string" ||
    !ENDPOINT_COOKIE_OPS.includes(op.toLowerCase())
  ) {
    return false
  }

  const endpoint = args["cdp_url"]
  return typeof endpoint === "string" && endpoint.trim().length > 0
}

export type WebrainToolRefusal =
  | "unknown-tool"
  | "tier"
  | "shared-worker"
  | "own-worker"

export interface WebrainToolDecision {
  allowed: boolean
  tier: WebrainTier
  refusal?: WebrainToolRefusal
}

/**
 * The tier a request runs at. Anything not explicitly free counts as paid, for
 * the
 * same reason as `scrape-providers.domain.ts`: a new access mode added by
 * billing
 * must not silently read as a free user.
 * @param {*} accessMode
 * @return {*}
 */
export const webrainTierFor = (accessMode: string | undefined): WebrainTier => {
  if (accessMode === "admin") {
    return "admin"
  }
  return isPaidAccess(accessMode) ? "paid" : "free"
}

/**
 * May this tier call this tool?
 *
 * Admin is intentionally unrestricted: an operator diagnosing a tenant's
 * failure
 * needs the tool that failed, and gating that would push them to bypass the
 * gateway altogether, which is worse than the risk it removes. Every other tier
 * is
 * allowlisted, and an unrecognised name is refused rather than forwarded — the
 * refusal is the point, not an oversight.
 * @param {*} accessMode
 * @param {*} toolName
 * @param {*} args
 * @return {*}
 */
export const decideWebrainTool = (
  accessMode: string | undefined,
  toolName: unknown,
  args?: Record<string, unknown>
): WebrainToolDecision => {
  const tier = webrainTierFor(accessMode)

  if (typeof toolName !== "string" || toolName.length === 0) {
    return { allowed: false, tier, refusal: "unknown-tool" }
  }

  if (tier === "admin") {
    return { allowed: true, tier }
  }

  // Ahead of the tier allowlist, and not a hole in it: the reason the vault ops
  // sit behind a tier is the worker's process-global vault, which a cookie call
  // with the caller's own endpoint never opens. Every other op on this tool is
  // still refused below, and a cookie call without an endpoint still is too.
  if (isEndpointCookieCall(toolName, args)) {
    return { allowed: true, tier }
  }

  if (SHARED_POOL_TOOLS.includes(toolName)) {
    return { allowed: true, tier }
  }

  if (PAID_ONLY_TOOLS.includes(toolName)) {
    return tier === "paid" ?
      { allowed: true, tier } :
      { allowed: false, tier, refusal: "tier" }
  }

  return { allowed: false, tier, refusal: "unknown-tool" }
}

/**
 * The message a caller sees when a tool is refused.
 *
 * Written here, next to the decision, so a refusal cannot be reported as a
 * generic
 * failure. "Session tools need a private worker" sends the user to the right
 * remedy; "the provider returned no result" sends them to support.
 * @param {*} refusal
 * @return {*}
 */
export const webrainToolRefusalMessage = (
  refusal: WebrainToolRefusal
): string => {
  if (refusal === "own-worker") {
    return "Needs your own worker: this tool uses the credential vault, " +
      "which a shared worker keeps between callers"
  }
  if (refusal === "shared-worker") {
    return "Needs a private worker: this tool reads the current page, " +
      "which a shared process cannot attribute to one caller"
  }
  if (refusal === "tier") {
    return "Needs a private worker; the shared pool serves stateless work"
  }
  return "That tool is not available through the platform gateway"
}
