/* eslint-disable object-curly-spacing */
/**
 * One place a capability declares what it requires.
 *
 * Why this exists
 * ---------------
 * The same requirement is currently restated in six places and three different
 * shapes:
 *
 *  - `requirePaidAccess, requirePermission(...)` spelled out on each route in
 *    `infrastructure/syncaiapi.ts`;
 *  - `minAccess: "free" | "paid"` on every row of `scrape-providers.domain.ts`;
 *  - the same `minAccess` union, declared a second time, in
 *    `user-ai-settings.domain.ts`;
 *  - membership in `SHARED_POOL_TOOLS` / `PAID_ONLY_TOOLS`;
 *  - `MONITOR_MAX_PER_USER`, a quota living in `monitors.domain.ts`;
 *  - and all of it again in the frontend's `feature-gate.policy.ts`.
 *
 * They agree today by discipline. A new route that forgets its guard, or a
 * catalogue row added without a requirement, fails open or closed with nothing
 * to notice it. This file is the single declaration those readers should read.
 *
 * The axes are kept apart on purpose, because conflating them is the bug class
 * this replaces:
 *
 *   entitlement -- may you spend our money      (402)
 *   permission  -- may you touch this resource  (403)
 *   quota       -- how much may you have        (refusal)
 *
 * `monitor` is the worked example: free entitlement, a quota, and no permission
 * beyond the caller's own uid. That is why its routes carry `resolveAccess`
 * rather than `requirePaidAccess` -- a fact that previously existed only as a
 * comment on the handler.
 *
 * Credential SOURCE (platform key vs the caller's own) is deliberately absent:
 * it is not a tier, it changes who pays, and expressing it as `minAccess` is
 * why BYOK reads as paid-only when it is really a cost modifier.
 */

import {isPaidAccess} from "./scrape-providers.domain"

/** The capabilities the platform gates. Named for the act, not the route. */
export type Capability =
  | "ai.execute"
  | "ai.byok"
  | "crawl.execute"
  | "webrain.stateless"
  | "monitor"
  | "proxy.platform"
  | "proxy.byop"
  | "machine.deploy"
  | "storage.read"
  | "storage.write"
  | "webrain.inspect"
  | "webrain.configure"

export interface CapabilityRequirement {
  /**
   * The lowest entitlement that may use it.
   *
   * `admin` here means admin-only. A platform admin bypasses every row, by
   * design: an operator diagnosing a tenant's failure needs the thing that
   * failed, and gating it pushes them to bypass the gateway entirely.
   */
  entitlement: "free" | "paid" | "admin"
  /** The RBAC pair the route must also pass, when it is not uid-scoped. */
  permission?: { resource: string; action: string }
  /** A per-user ceiling, when the scarce resource is a shared pool. */
  quota?: { key: string; freeLimit: number; paidLimit: number }
}

/**
 * The table.
 *
 * `webrain.stateless` is free by cost structure, not by generosity: those calls
 * are a CPU burst plus egress, which a shared pool absorbs. The stateful and
 * capacity-bearing webrain tools stay behind `crawl.execute`.
 */
export const CAPABILITIES: Record<Capability, CapabilityRequirement> = {
  "ai.execute": {
    entitlement: "paid",
    permission: { resource: "ai", action: "execute" },
  },
  "ai.byok": { entitlement: "paid" },
  "crawl.execute": {
    entitlement: "paid",
    permission: { resource: "crawl", action: "execute" },
  },
  "webrain.stateless": {
    entitlement: "free",
    permission: { resource: "crawl", action: "execute" },
  },
  "monitor": {
    entitlement: "free",
    quota: { key: "monitors", freeLimit: 20, paidLimit: 200 },
  },
  // Egress is charged for OURS, never for theirs, which is why this is two rows
  // and not one. A platform entry spends our bandwidth and our IP reputation; a
  // caller-supplied proxy spends neither. Charging for BYOP would tax the path
  // that costs us least and push callers onto the expensive one.
  "proxy.platform": { entitlement: "paid" },
  "proxy.byop": { entitlement: "free" },
  "machine.deploy": {
    entitlement: "paid",
    permission: { resource: "machine", action: "deploy" },
  },
  // Stored artifacts are the caller's own bytes: keeping them costs storage and
  // nothing else, and gating them would refuse an account the ability to hold
  // what it already fetched. What isolates one caller's objects from another's
  // is the uid-scoped `self` role in `authz.domain.ts`, not the entitlement.
  "storage.read": {
    entitlement: "free",
    permission: { resource: "storage", action: "read" },
  },
  "storage.write": {
    entitlement: "free",
    permission: { resource: "storage", action: "write" },
  },
  // The webrain configuration is a platform credential and a platform spend:
  // one bearer token the worker trusts, and one egress pool we pay for. No
  // tenant role may touch either, so both rows are `admin` -- a row that
  // resolves true ONLY through the platform-admin short-circuit in
  // `canPerform`, which is why neither appears in `POLICIES`.
  "webrain.inspect": {
    entitlement: "admin",
    permission: { resource: "platform", action: "read" },
  },
  "webrain.configure": {
    entitlement: "admin",
    permission: { resource: "platform", action: "write" },
  },
}

/**
 * The declaration for one capability.
 * @param {Capability} capability The capability.
 * @return {CapabilityRequirement} Its requirement.
 */
export const requirementFor = (capability: Capability): CapabilityRequirement =>
  CAPABILITIES[capability]

/**
 * Whether an entitlement satisfies a requirement.
 *
 * Anything not explicitly free counts as paid, matching `isPaidAccess`: a new
 * access mode introduced by billing must not silently read as a free user.
 * @param {*} required The declared minimum entitlement.
 * @param {string|undefined} accessMode The resolved entitlement.
 * @return {boolean} True when the caller may proceed.
 */
export const satisfiesEntitlement = (
  required: CapabilityRequirement["entitlement"],
  accessMode: string | undefined
): boolean => {
  if (accessMode === "admin") {
    return true
  }

  if (required === "admin") {
    return false
  }

  return required === "free" ? true : isPaidAccess(accessMode)
}

/**
 * The ceiling that applies to a quota, for this caller.
 *
 * A capability with no quota has no ceiling, so this returns `Infinity` rather
 * than zero -- the failure of getting that backwards is a feature nobody can
 * use.
 * @param {Capability} capability The capability.
 * @param {string|undefined} accessMode The resolved entitlement.
 * @return {number} The per-user limit.
 */
export const quotaLimitFor = (
  capability: Capability,
  accessMode: string | undefined
): number => {
  const quota = CAPABILITIES[capability].quota
  if (!quota) {
    return Infinity
  }
  return accessMode === "admin" || isPaidAccess(accessMode) ?
    quota.paidLimit :
    quota.freeLimit
}
