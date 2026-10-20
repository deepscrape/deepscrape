/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * Charging one session's browser time — the money step, in ONE place.
 *
 * There are two callers and they must not diverge: the scheduled sweep
 * (`gfunctions/browser-meter.ts`), and the close route, which performs a final
 * charge so a session that ends between two sweeps is still billed for its last
 * block. That second caller is not a nicety — without it, ending a session is a
 * way to avoid paying for the final block, and because the sweep's query
 * excludes `closed` the loss would be permanent rather than merely late.
 *
 * Split into wallet and charge on purpose. The wallet depends only on the
 * caller, so the sweep resolves it ONCE per uid and reuses it across that
 * caller's sessions, while the charge is inherently per session. Merging them
 * would force the sweep into one billing read per session.
 */
import {db} from "../app/config"
import {consumeBillingCredits} from "../app/billing-credits"
import {getBillingAccessMode, type BillingSnapshot} from "../domain/billing.domain"
import {resolveBillingPricingPolicy} from "../domain/billing-pricing.domain"
import {machineChargeFor, type BrowserSessionRecord} from "../domain/browser-session.domain"
import {
  billableMinutes,
  isMeterBillable,
  isMeteredTier,
  meterChargeFor,
  METER_LEDGER_SOURCE,
} from "../domain/browser-meter.domain"
import {recordCallerSpend} from "./billing-spend.store"
import {recordMeteredMinutes} from "./browser-session.store"

/**
 * The action whose price decides which wallet is charged.
 *
 * Read, never restated. `machineChargeFor` derives the bucket from the access
 * mode and is the same function the deploy route calls, so a browser minute and
 * a machine deploy cannot come to draw on different pots. The path is the deploy
 * route's because that is the action that priced this session's compute.
 *
 * A consequence worth knowing: `machineChargeFor` returns null when the deploy
 * price is non-positive, so a zero-priced deploy action switches the meter off
 * too. That is fail-closed and deliberate — one place decides whether compute is
 * billable, and this is not a second one.
 */
const METER_POLICY_METHOD = "POST"
const METER_POLICY_PATH = "/machines/deploy"

/** The wallet a caller's browser time is billed to. */
export type MeterWallet = {
  bucket: "purchased" | "included"
}

/**
 * Which wallet this caller's browser time is billed to, or nothing.
 *
 * `undefined` means this caller has no billable wallet at all: free, admin,
 * grace, or a plan whose deploy action is priced at zero. The caller must then
 * charge nothing rather than pick a wallet — choosing one "as a fallback" is how
 * an unbillable session gets billed to a pot nobody agreed to.
 * @param {string} uid The verified caller uid.
 * @param {number} now Epoch ms, for the access-mode derivation.
 * @return {Promise<MeterWallet | undefined>} The wallet, or undefined.
 */
export const meterWalletFor = async (
  uid: string,
  now: number,
): Promise<MeterWallet | undefined> => {
  const snapshot = await db.doc(`users/${uid}/billing/current`).get()
  const billing = snapshot.data() as BillingSnapshot | undefined
  const accessMode = getBillingAccessMode(billing, now)
  const charge = machineChargeFor(
    accessMode,
    resolveBillingPricingPolicy(METER_POLICY_METHOD, METER_POLICY_PATH),
  )
  return charge ? {bucket: charge.bucket} : undefined
}

/**
 * Charge every unbilled block of one session, then advance its counter.
 *
 * Idempotent by construction rather than by care: each block is charged under a
 * deterministic ledger key (`bs-meter:<sessionId>:block:<n>`), and
 * `applyBillingCreditMutation` treats a re-used key as already applied. So
 * calling this twice charges once, and a retry after a partial failure cannot
 * double-charge — which is what makes it safe to call from both a retry loop and
 * the close route.
 *
 * The counter is advanced ONLY after every key has been applied. If a charge
 * throws, the counter stays put so the next attempt re-derives the same keys;
 * advancing it first would record money as paid that was never collected.
 *
 * This returns the number of credits actually applied rather than throwing on a
 * wallet refusal, because a caller low on credits is a normal outcome the routes
 * already have answers for, not an exceptional one.
 * @param {string} uid The verified caller uid.
 * @param {BrowserSessionRecord} record The session, as stored.
 * @param {MeterWallet} wallet The wallet to charge, from `meterWalletFor`.
 * @param {number} now Epoch ms; the billable window is clamped to this.
 * @return {Promise<number>} How many credits were applied, 0 if none were due.
 */
export const chargeSessionMeter = async (
  uid: string,
  record: BrowserSessionRecord,
  wallet: MeterWallet,
  now: number,
): Promise<number> => {
  // Nothing is charged for compute the platform did not supply: a BYO session
  // either has no machine at all (their own CDP endpoint) or has one in their own
  // Fly organization, the free tier never receives a machine, and admin is the
  // operator. Charging any of them would bill for a machine we never ran.
  //
  // The whole record is passed, not `record.machineId`: those are two different
  // facts, and handing in only one of them is how the other got forgotten when
  // compute moved into the caller's organization.
  if (!isMeterBillable(record) || !isMeteredTier(record.tier)) {
    return 0
  }

  const minutes = billableMinutes(record.createdAt, now, record.idleDeadline)
  const plan = meterChargeFor(record.id, minutes, record.minutesBilled)
  if (plan.keys.length === 0) {
    return 0
  }

  let charged = 0
  for (const key of plan.keys) {
    const applied = await consumeBillingCredits({
      uid,
      amount: 1,
      bucket: wallet.bucket,
      // Mandatory, not stylistic: `consumeBillingCredits` defaults `reservedDelta`
      // to `-amount` because it assumes a reservation was taken earlier. A metered
      // charge has no reservation behind it, so the default would drive `reserved`
      // below zero and corrupt the wallet's balance/reserved pair.
      releaseReserved: false,
      ledger: {
        source: METER_LEDGER_SOURCE,
        reason: "meter:block",
        sessionId: record.id,
        metadata: {block: key},
        idempotencyKey: key,
      },
    })
    if (applied) {
      charged += 1
    }
  }

  // The customer's own counter, advanced BEFORE the minutes counter and by what
  // was ACTUALLY collected rather than by what was due. A block the wallet
  // refused collected nothing, and counting it would let a customer reach their
  // cap without ever being billed -- `charged` is already that number, so there
  // is no second count to drift.
  //
  // The order is chosen, not incidental. These two writes are not atomic, and a
  // failure between them has to leave the cap OVER-counted rather than under:
  // over-counting refuses a charge the customer would have been allowed
  // (recoverable, and it self-corrects at the period boundary), while
  // under-counting is the unbounded invoice this whole pair of modules exists to
  // prevent. It is also why this sits outside the loop -- a partial failure
  // re-runs the whole set, and recording inside would double-count the blocks
  // that already succeeded.
  await recordCallerSpend(uid, charged, now)

  await recordMeteredMinutes(uid, record.id, minutes)
  return charged
}
