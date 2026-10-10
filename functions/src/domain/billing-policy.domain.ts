/* eslint-disable max-len *//* eslint-disable object-curly-spacing */
/**
 * The customer's own spend policy (roadmap `07` Part C, master step 15).
 *
 * Why this is separate from `billing.domain.ts`
 * --------------------------------------------
 * `billing.domain.ts` answers "what does this customer HOLD" — plan, credits,
 * buckets, access mode. This answers "what did they say they would SPEND". Two
 * different questions, and conflating them is how a customer with credits gets
 * billed past a limit they set themselves.
 *
 * It is pure for the same reason `browser-meter.domain.ts` is: a mistake here
 * is not a wrong number on a dashboard, it is an invoice nobody agreed to. So
 * there is no clock and no database — the caller supplies the accumulated
 * spend and the period, and a spec can assert every boundary without an
 * emulator.
 *
 * THE ONE RULE — the cap FAILS CLOSED
 * -----------------------------------
 * `enforceBudget` and friends deliberately fail open when Redis is
 * unavailable. That is correct for a rate limit and catastrophic for money: a
 * cache blip would become an unbounded invoice. So "cannot read the counter"
 * is treated as AT the cap — but only when a cap is actually configured. A
 * customer who never set one has no cap to be at, and refusing them would take
 * the whole free tier down on a Redis blip. That distinction is why `window`
 * is possibly-absent rather than defaulted to zero.
 *
 * Contract, and its ceiling
 * -------------------------
 * `window` must be the counter for the CURRENT period. This module does not
 * compare `periodStartMs` against `now`, because the counter is keyed by
 * period and so resets without a job. If a caller ever passes a stale window
 * the effect is a wrongly-REFUSED charge, which fails safe — a support ticket
 * rather than an invoice. Add the period guard here if that ever happens.
 */

/** The window a spend cap is enforced over. */
export type SpendPeriod = "day" | "month"

/** What the customer asked to happen once the cap is reached. */
export type SpendExhaustAction = "block" | "degrade"

/**
 * The policy document at `users/{uid}/billing/policy`.
 *
 * Every field is optional on purpose: an absent document is a customer with no
 * cap, which is the pre-existing behaviour and must not change.
 */
export type SpendPolicy = {
  /**
   * Cap for the period, in CREDITS. `0` or absent means no cap.
   *
   * Credits, not minor currency units, and that is forced rather than chosen:
   * the roadmap wrote `spendCapMinor`, but nothing in the platform converts a
   * credit to money. `creditPackCatalog` prices packs at 19.0 minor units per
   * credit (100 for 1900) and 15.8 (500 for 7900), so there is no single rate
   * to read — and a credit granted by a PLAN has no unit price at all. Deriving
   * `spentMinor` would therefore need lot accounting over `credits_ledger`,
   * which is an accounting feature and not this one. Credits are also the unit
   * the platform already charges in, so a cap in credits needs no new concept.
   */
  spendCapCredits?: number
  period?: SpendPeriod
  onExhaust?: SpendExhaustAction
  dailyFreeCredits?: number
  alertsAt?: number[]
}

/** Spend accumulated in the current period, as read from the counter. */
export type SpendWindow = {
  /** Epoch ms the current period began. */
  periodStartMs: number
  /** Credits spent in this period so far. */
  spentCredits: number
}

/** Why a request was refused. */
export type SpendRefusal =
  /** The charge would take the period past the configured cap. */
  | "budget"
  /** A cap is configured and its counter could not be read. */
  | "cap-unreadable"

/** The outcome of the cap check. */
export type SpendDecision =
  | {allowed: true; degrade: boolean}
  | {allowed: false; reason: SpendRefusal}

/**
 * Epoch ms at which the current period began.
 *
 * UTC, not local time: the period must not move when a customer travels, and a
 * DST shift would otherwise make one day 23 hours and the next 25 — a cap that
 * silently changes length is a cap nobody can reason about.
 * @param {number} now Epoch ms to resolve the period for.
 * @param {SpendPeriod} period The configured period.
 * @return {number} Epoch ms of the period start.
 */
export const periodStart = (now: number, period: SpendPeriod): number => {
  const date = new Date(now)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  return period === "day"? Date.UTC(year, month,
    date.getUTCDate()): Date.UTC(year, month, 1)
}

/**
 * Whether `chargeMinor` may be spent, given the policy and the counter.
 *
 * Checked BEFORE anything is reserved, so a reservation can never take the
 * period past the cap. That ordering IS the feature — a cap applied after the
 * charge is a report, not a limit.
 *
 * `onExhaust` is returned rather than acted on. This module knows the POLICY;
 * only the caller knows which cheaper path exists to fall back to, so choosing
 * what to drop belongs there. `degrade` is therefore only ever true on an
 * allowed decision — a refusal is a refusal whatever the action says.
 * @param {SpendPolicy|undefined} policy The stored policy, if any.
 * @param {SpendWindow|undefined} window The counter, or undefined if
 *   unreadable.
 * @param {number} chargeCredits Credits being attempted.
 * @return {SpendDecision} Allowed with the exhaust action, or refused.
 */
export const decideSpend = (
  policy: SpendPolicy | undefined,
  window: SpendWindow | undefined,
  chargeCredits: number
): SpendDecision => {
  const cap = policy?.spendCapCredits
  // No cap configured is not "a cap of zero": there is nothing to be at, so an
  // unreadable counter must not refuse a customer who never opted in.
  if (typeof cap !== "number" || cap <= 0) {
    return {allowed: true, degrade: false}
  }
  if (!window) {
    return {allowed: false, reason: "cap-unreadable"}
  }
  // `>` and not `>=`: a charge that lands exactly on the cap is allowed, which
  // is what "a cap of 50" means to the person who set it.
  if (window.spentCredits + chargeCredits > cap) {
    return {allowed: false, reason: "budget"}
  }
  return {allowed: true, degrade: policy?.onExhaust === "degrade"}
}

/**
 * Free calls remaining in today's window — the funnel in `07` Part D.
 *
 * Clamped at zero: an over-spend must not read as a negative allowance and
 * then be handed back out by an arithmetic slip downstream.
 * @param {SpendPolicy|undefined} policy The stored policy, if any.
 * @param {number} usedToday Calls already spent in today's window.
 * @return {number} Calls remaining, never negative.
 */
export const freeAllowanceRemaining = (
  policy: SpendPolicy | undefined,
  usedToday: number
): number => {
  const allowance = policy?.dailyFreeCredits
  if (typeof allowance !== "number" || allowance <= 0) {
    return 0
  }
  return Math.max(0, allowance - usedToday)
}
