/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The customer's own spend cap - roadmap `07` Part C, master step 15.
 *
 * Why this is a route and not just a store
 * ----------------------------------------
 * `domain/billing-policy.domain.ts` decides, purely, whether a charge is
 * allowed. It is inert on its own: a decision nobody calls and a number nobody
 * can set are the same as no feature. These two routes are the write half (let
 * a customer state a cap) and the read half (let a surface show the cap against
 * what has been spent against it).
 *
 * The unit is CREDITS, not currency
 * ---------------------------------
 * `07` wrote `spendCapMinor`, and that field cannot be honoured: nothing in the
 * platform converts a credit to money. `creditPackCatalog` prices 100 credits at
 * 1900 minor units and 500 at 7900, so the rate is 19.0 or 15.8 depending on the
 * pack, and a credit granted by a PLAN has no unit price at all. Producing
 * `spentMinor` would need lot accounting over `credits_ledger`. Credits are
 * already the unit the platform charges in, so a cap in credits introduces no
 * new concept - which is why this is not a change to the shape of pricing.
 *
 * A `0` cap is written, not omitted, when a customer clears one
 * ------------------------------------------------------------------
 * `writeSpendPolicy` merges. So an omitted `spendCapCredits` means "leave the
 * existing cap alone" and `spendCapCredits: 0` means "remove it". The domain
 * reads a zero cap as no cap, so both halves agree without this route having to
 * delete a field.
 */
import { Request, Response } from "express"
import {
  readSpendPolicy,
  readSpendWindow,
  writeSpendPolicy,
} from "../infrastructure/billing-spend.store"
import type {
  SpendExhaustAction,
  SpendPeriod,
  SpendPolicy,
} from "../domain/billing-policy.domain"

/** The periods a cap may be enforced over. */
const PERIODS: readonly SpendPeriod[] = ["day", "month"]

/** What may happen once the cap is reached. */
const EXHAUST_ACTIONS: readonly SpendExhaustAction[] = ["block", "degrade"]

/**
 * The caller's uid, or undefined when the token carried none.
 * @param {Request} req The request.
 * @return {string | undefined} The verified uid.
 */
const uidOf = (req: Request): string | undefined => {
  const uid = req.user?.uid
  return typeof uid === "string" && uid.length ? uid : undefined
}

/**
 * The 401 for a token that carried no uid.
 * @param {Response} res The response.
 */
const unauthorized = (res: Response): void => {
  res.status(401).json({error: "unauthorized", code: "unauthorized"})
}

/**
 * A whole number, or undefined when the value is anything else.
 *
 * Used for the credit counts, where a fractional or negative value is a
 * malformed request rather than something to round. Rounding would turn a
 * typo into a silent policy change.
 * @param {unknown} value The untrusted value.
 * @return {number | undefined} The number, or undefined.
 */
const asWholeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ?
    value : undefined

/**
 * Validate one untrusted policy body into the fields to write.
 *
 * Strict on type and permissive on presence: a field that is ABSENT is left
 * alone by the merge, which is what lets a caller change the cap without
 * restating the period. A field that is PRESENT but malformed is a refusal, not
 * a coercion - accepting `"500"` here would make the stored document's type
 * depend on which client wrote it.
 * @param {unknown} body The untrusted request body.
 * @return {Partial<SpendPolicy> | undefined} Fields to write, or undefined.
 */
const parsePolicy = (body: unknown): Partial<SpendPolicy> | undefined => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined
  }
  const raw = body as Record<string, unknown>
  const policy: Partial<SpendPolicy> = {}

  if ("spendCapCredits" in raw) {
    const cap = asWholeNumber(raw.spendCapCredits)
    if (cap === undefined) {
      return undefined
    }
    policy.spendCapCredits = cap
  }
  if ("dailyFreeCredits" in raw) {
    const daily = asWholeNumber(raw.dailyFreeCredits)
    if (daily === undefined) {
      return undefined
    }
    policy.dailyFreeCredits = daily
  }
  if ("period" in raw) {
    const period = raw.period
    if (!PERIODS.includes(period as SpendPeriod)) {
      return undefined
    }
    policy.period = period as SpendPeriod
  }
  if ("onExhaust" in raw) {
    const action = raw.onExhaust
    if (!EXHAUST_ACTIONS.includes(action as SpendExhaustAction)) {
      return undefined
    }
    policy.onExhaust = action as SpendExhaustAction
  }
  if ("alertsAt" in raw) {
    const alerts = raw.alertsAt
    // Ascending percentages. Not sorted here on purpose: the customer's order
    // is a statement about which thresholds matter first, and silently
    // reordering it would make the stored document disagree with what they sent.
    if (!Array.isArray(alerts) ||
      !alerts.every((value) => asWholeNumber(value) !== undefined)) {
      return undefined
    }
    policy.alertsAt = alerts as number[]
  }

  // An empty object is refused rather than accepted as a no-op. A 200 that
  // changed nothing reads as "your cap was saved" to every client that does not
  // re-read, which is a false confirmation about money.
  return Object.keys(policy).length ? policy : undefined
}

/**
 * `GET /api/billing/policy` - the caller's cap, and what is spent against it.
 *
 * `window` is returned even for a customer with no cap, because "spent 12
 * credits this month, no cap set" is a useful and honest statement, and reading
 * it costs one document. It is `null` only when the counter read FAILED, which
 * is a different fact from a counter of zero and must not be shown as one.
 * @param {Request} req The request.
 * @param {Response} res The response.
 * @return {Promise<void>} Nothing.
 */
export const billingPolicyGet = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    unauthorized(res)
    return
  }

  try {
    const policy = await readSpendPolicy(uid)
    const period: SpendPeriod = policy?.period ?? "month"
    const window = await readSpendWindow(uid, period, Date.now())
    res.status(200).json({
      status: "ok",
      policy: policy ?? null,
      period: period,
      window: window ?? null,
    })
  } catch (error) {
    console.error("[billing-policy] read failed", error)
    res.status(500).json({status: "error", code: "policy_unavailable"})
  }
}

/**
 * `PUT /api/billing/policy` - set or clear the caller's spend cap.
 *
 * A merge, so this route cannot drop a field the caller did not mention. That
 * is also why there is no DELETE: clearing a cap is `spendCapCredits: 0`, and a
 * separate delete path would be a second way to reach one state.
 * @param {Request} req The request.
 * @param {Response} res The response.
 * @return {Promise<void>} Nothing.
 */
export const billingPolicySet = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    unauthorized(res)
    return
  }

  const policy = parsePolicy(req.body)
  if (!policy) {
    res.status(400).json({status: "error", code: "invalid_policy"})
    return
  }

  try {
    await writeSpendPolicy(uid, policy)
    res.status(200).json({status: "ok", policy: policy})
  } catch (error) {
    console.error("[billing-policy] write failed", error)
    res.status(500).json({status: "error", code: "policy_unavailable"})
  }
}
