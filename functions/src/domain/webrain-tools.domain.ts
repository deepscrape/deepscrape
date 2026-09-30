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
 */
export const SHARED_POOL_TOOLS: readonly string[] = [
  "webrain_guide",
  "webrain_scrape",
  "webrain_search",
  "webrain_serp",
  "webrain_extract",
  "webrain_pdf",
  "webrain_download",
  "webrain_watch",
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
]

export type WebrainToolRefusal = "unknown-tool" | "tier"

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
 * @return {*}
 */
export const decideWebrainTool = (
  accessMode: string | undefined,
  toolName: unknown,
): WebrainToolDecision => {
  const tier = webrainTierFor(accessMode)

  if (typeof toolName !== "string" || toolName.length === 0) {
    return { allowed: false, tier, refusal: "unknown-tool" }
  }

  if (tier === "admin") {
    return { allowed: true, tier }
  }

  if (SHARED_POOL_TOOLS.includes(toolName)) {
    return { allowed: true, tier }
  }

  if (PAID_ONLY_TOOLS.includes(toolName)) {
    return tier === "paid" ? { allowed: true, tier } : { allowed: false, tier, refusal: "tier" }
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
export const webrainToolRefusalMessage = (refusal: WebrainToolRefusal): string => {
  if (refusal === "tier") {
    return "This tool needs a private worker; the shared pool serves stateless work only"
  }
  return "That tool is not available through the platform gateway"
}
