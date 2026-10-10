/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * Where a customer's spend policy lives, and where their period counter does.
 *
 * Two documents, deliberately not one. `users/{uid}/billing/policy` is the
 * customer's own configuration and a route writes it. The counter is platform
 * bookkeeping the customer must never write — if the two shared a document,
 * zeroing the counter would be a way to defeat the very cap they set.
 *
 * The counter is keyed BY PERIOD in the document ID, so a new period is a new
 * document rather than a field that has to be reset. That removes the roll-over
 * race outright: there is no "did the period move?" read, and no write that
 * could clobber a concurrent increment. Each period's document is prunable by
 * date and never grows.
 *
 * READ vs UNREADABLE is the whole fail-closed rule, and the caller must not
 * lose the distinction. A MISSING counter document is a real zero — this period
 * has not been spent in. A THROWING read is `undefined`, which the domain turns
 * into a refusal for a capped customer and an allowance for a capless one.
 * Collapsing those two into a plain zero is exactly the Redis-blip-becomes-an-
 * unbounded-invoice bug this pair of modules exists to prevent, and the catch
 * below is deliberate rather than defensive: a permission error fails closed
 * too, which is the safe direction for money.
 */
import {FieldValue} from "firebase-admin/firestore"
import {db} from "../app/config"
import {
  decideSpend,
  periodStart,
  type SpendDecision,
  type SpendPeriod,
  type SpendPolicy,
  type SpendWindow,
} from "../domain/billing-policy.domain"

/**
 * The customer's own policy document.
 * @param {string} uid The verified caller uid.
 * @return {*} The Firestore document reference.
 */
const policyRef = (uid: string) => db.doc(`users/${uid}/billing/policy`)

/**
 * The counter document for one period.
 * @param {string} uid The verified caller uid.
 * @param {string} key The period key.
 * @return {*} The Firestore document reference.
 */
const spendRef = (uid: string, key: string) =>
  db.doc(`users/${uid}/billing/spend/${key}`)

/**
 * The counter's document id for a period.
 *
 * ISO-derived, so the keys sort lexically and a month key can never collide
 * with a day key (`2026-10` against `2026-10-04`).
 * @param {number} startMs Epoch ms of the period start.
 * @param {SpendPeriod} period The configured period.
 * @return {string} `YYYY-MM-DD` for a day, `YYYY-MM` for a month.
 */
export const spendPeriodKey = (
  startMs: number,
  period: SpendPeriod,
): string => {
  const iso = new Date(startMs).toISOString()
  return period === "day" ? iso.slice(0, 10) : iso.slice(0, 7)
}

/**
 * The customer's spend policy, or undefined when they never set one.
 *
 * An absent document is not an error and not a zero cap: it is the pre-existing
 * behaviour, a customer who never opted in.
 * @param {string} uid The verified caller uid.
 * @return {Promise<SpendPolicy | undefined>} The policy, or undefined.
 */
export const readSpendPolicy = async (
  uid: string,
): Promise<SpendPolicy | undefined> => {
  const snapshot = await policyRef(uid).get()
  return snapshot.exists ? (snapshot.data() as SpendPolicy) : undefined
}

/**
 * Store the customer's policy, leaving absent fields alone.
 *
 * Merged rather than replaced so a caller that sets only `spendCapCredits`
 * cannot silently drop the customer's `period` or `alertsAt`. Clearing a cap is
 * `spendCapCredits: 0`, which the domain reads as "no cap" — an omitted field
 * means "leave it as it was", and those must not be the same request.
 * @param {string} uid The verified caller uid.
 * @param {SpendPolicy} policy The fields to write.
 * @return {Promise<void>} Nothing.
 */
export const writeSpendPolicy = async (
  uid: string,
  policy: SpendPolicy,
): Promise<void> => {
  await policyRef(uid).set({
    ...policy,
    updatedAt: FieldValue.serverTimestamp(),
  }, {merge: true})
}

/**
 * Spend accumulated in the current period, or undefined when unreadable.
 *
 * `undefined` is the fail-closed signal and is NOT the same as a window of
 * zero. The caller passes it through to `decideSpend` untouched.
 * @param {string} uid The verified caller uid.
 * @param {SpendPeriod} period The configured period.
 * @param {number} now Epoch ms, to resolve which period we are in.
 * @return {Promise<SpendWindow | undefined>} The counter, or undefined.
 */
export const readSpendWindow = async (
  uid: string,
  period: SpendPeriod,
  now: number,
): Promise<SpendWindow | undefined> => {
  const startMs = periodStart(now, period)
  try {
    const snapshot = await spendRef(uid, spendPeriodKey(startMs, period)).get()
    const credits = snapshot.data()?.credits
    return {
      periodStartMs: startMs,
      spentCredits:
        typeof credits === "number" && Number.isFinite(credits) ? credits : 0,
    }
  } catch {
    return undefined
  }
}

/**
 * Add to the current period's counter.
 *
 * `increment` rather than a read-modify-write, so the scheduled sweep and the
 * close route cannot lose each other's spend — they genuinely can run at the
 * same moment. Non-positive amounts are dropped rather than writing a zero.
 * @param {string} uid The verified caller uid.
 * @param {number} credits Credits just spent.
 * @param {SpendPeriod} period The configured period.
 * @param {number} now Epoch ms, to resolve which period we are in.
 * @return {Promise<void>} Nothing.
 */
export const recordSpend = async (
  uid: string,
  credits: number,
  period: SpendPeriod,
  now: number,
): Promise<void> => {
  if (!Number.isFinite(credits) || credits <= 0) {
    return
  }
  const startMs = periodStart(now, period)
  await spendRef(uid, spendPeriodKey(startMs, period)).set({
    credits: FieldValue.increment(credits),
    periodStartMs: startMs,
    updatedAt: FieldValue.serverTimestamp(),
  }, {merge: true})
}

/**
 * Whether this caller may spend `chargeCredits` right now.
 *
 * The composition the routes share, so the admission check and the counter
 * cannot disagree about which period they are talking about.
 *
 * The policy read failing is a REFUSAL, not an allowance. That is the same
 * fail-closed direction as an unreadable counter and it is the harder of the
 * two to get right: an unreadable counter only matters when we know a cap
 * exists, whereas an unreadable POLICY means we cannot tell whether one exists
 * at all. Defaulting to "no cap" there would let one failed read switch the
 * cap off for everyone, which is precisely the shape of bug this pair of
 * modules exists to prevent. In practice a Firestore outage already fails the
 * reservation that follows, so this makes the failure explicit rather than
 * adding a new way to be down.
 * @param {string} uid The verified caller uid.
 * @param {number} chargeCredits Credits the request would spend.
 * @param {number} now Epoch ms, to resolve the period.
 * @return {Promise<SpendDecision>} The decision, refusal reasons included.
 */
export const decideCallerSpend = async (
  uid: string,
  chargeCredits: number,
  now: number,
): Promise<SpendDecision> => {
  let policy: SpendPolicy | undefined
  try {
    policy = await readSpendPolicy(uid)
  } catch {
    return {allowed: false, reason: "cap-unreadable"}
  }
  const period = policy?.period ?? "month"
  const window = await readSpendWindow(uid, period, now)
  return decideSpend(policy, window, chargeCredits)
}

/**
 * Record credits spent, against the caller's own configured period.
 *
 * Reads the policy for its period rather than taking one, because the callers
 * that spend are the meter and the routes, and neither should be required to
 * know how a customer configured their cap. The extra document get is on a
 * document these paths already read.
 * @param {string} uid The verified caller uid.
 * @param {number} credits Credits just spent.
 * @param {number} now Epoch ms, to resolve the period.
 * @return {Promise<void>} Nothing.
 */
export const recordCallerSpend = async (
  uid: string,
  credits: number,
  now: number,
): Promise<void> => {
  let period: SpendPeriod = "month"
  try {
    const policy = await readSpendPolicy(uid)
    period = policy?.period ?? "month"
  } catch {
    // Recording must not fail a charge that already succeeded, and the default
    // period is the one a customer is overwhelmingly likely to have. This is
    // the opposite direction from `decideCallerSpend` on purpose: there, an
    // unreadable read risks the customer's money; here, it risks only the
    // counter's precision, and refusing to record would be worse than recording
    // under a default.
    period = "month"
  }
  await recordSpend(uid, credits, period, now)
}

/**
 * Whether this caller has reached their own cap — what the METER acts on.
 *
 * `decideCallerSpend` answers "may this charge proceed", which is the right
 * question at ADMISSION. This answers a different one: "is this customer at
 * their limit right now", which is what a sweep needs in order to STOP a
 * session that is already running. Refusing the meter's charge instead would
 * leave a running machine unpaid, which is strictly worse than the overspend it
 * would prevent — so the meter's response to a reached cap is to pull the idle
 * deadline forward, exactly as the platform's own 20-credit ceiling does.
 *
 * `>=` and not `>`: `decideSpend` allows a charge that lands exactly ON the cap,
 * which means a counter sitting at the cap has no room left. "Reached" is the
 * right predicate here even though "may I spend" uses `>`.
 * @param {string} uid The verified caller uid.
 * @param {number} now Epoch ms, to resolve the period.
 * @return {Promise<boolean>} Whether the cap is reached.
 */
export const capReached = async (
  uid: string,
  now: number,
): Promise<boolean> => {
  let policy: SpendPolicy | undefined
  try {
    policy = await readSpendPolicy(uid)
  } catch {
    // Same direction as `decideCallerSpend`, for the same reason: a cap we
    // cannot read is a cap we cannot prove is absent.
    return true
  }
  const cap = policy?.spendCapCredits
  if (typeof cap !== "number" || cap <= 0) {
    return false
  }
  const window = await readSpendWindow(uid, policy?.period ?? "month", now)
  if (!window) {
    return true
  }
  return window.spentCredits >= cap
}

/**
 * Tell a customer, once per period, that they crossed a threshold they set.
 *
 * Written from the METER rather than from a route, because the meter is the only
 * place that knows a session is being stopped for money — and a session that
 * dies with no explanation reads as a bug to the customer who just lost it.
 *
 * The document ID is deterministic — `spend-{periodKey}-{threshold}` — and that
 * is the entire idempotency story. `onSecurityAlertCreated` listens for
 * CREATION, so a second sweep in the same period writes an update, not an
 * event, and the customer is told once. A new period is a new key and therefore
 * a new alert, with no field to reset.
 *
 * ONE document, for the highest threshold crossed, not one per threshold. The
 * fan-out already throttles per (user, category) in Redis, so writing 50, 80 and
 * 100 together would yield one push and two bell entries — the noise without the
 * warning.
 *
 * No email, deliberately. It rides `presentAlert`'s unknown-category fallback,
 * which is push-only by design: email has to be opted INTO per category because
 * it costs money and domain reputation. Same reason `mfa_disabled` is push-only.
 *
 * @param {string} uid The verified caller uid.
 * @param {number} now Epoch ms, to resolve the period.
 * @return {Promise<void>} Nothing.
 */
export const alertCapReached = async (
  uid: string,
  now: number,
): Promise<void> => {
  try {
    const policy = await readSpendPolicy(uid)
    const cap = policy?.spendCapCredits
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) {
      return
    }
    const period = policy?.period ?? "month"
    const window = await readSpendWindow(uid, period, now)
    if (!window) {
      return
    }
    const percent = (window.spentCredits / cap) * 100
    const thresholds = (policy?.alertsAt?.length ? policy.alertsAt : [100])
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right)
    const crossed = thresholds.filter((value) => percent >= value).pop()
    if (crossed === undefined) {
      return
    }
    const key = spendPeriodKey(periodStart(now, period), period)
    await db.doc(`users/${uid}/alerts/spend-${key}-${crossed}`).set({
      category: "spend_cap",
      severity: crossed >= 100 ? "warning" : "info",
      title: crossed >= 100 ?
        "Spend cap reached" :
        `Spend cap ${crossed}% reached`,
      message: `You have spent ${window.spentCredits} of ${cap} credits this ` +
        `${period}. ${window.spentCredits >= cap ?
          "Running browser sessions have been stopped and new ones are blocked" :
          "New browser sessions will be blocked"} until the period resets.`,
      createdAt: FieldValue.serverTimestamp(),
      metadata: {
        cap,
        spent: window.spentCredits,
        percent: Math.round(percent),
        period: key,
      },
    }, {merge: true})
  } catch (error) {
    // Swallowed on purpose. The alert is not the control — the sweep is — and
    // this runs AFTER the sessions have already been stopped. Letting a failed
    // notification propagate would turn a courtesy into a failed sweep.
    console.error(`Spend cap alert failed for ${uid}:`, error)
  }
}
