/* eslint-disable max-len *//* eslint-disable object-curly-spacing */
/**
 * Metering platform browser time (roadmap `§1.6`, rate decided in `07`
 * Part E.1).
 *
 * Why this is pure, and why that matters more here than anywhere else
 * -------------------------------------------------------------------
 * This decides how many credits a session costs. A mistake is not a wrong
 * number on a dashboard — it is an invoice. So it is arithmetic over arguments,
 * with no clock and no database: the caller supplies `now`, the caller persists
 * the result, and a spec can assert every boundary without an emulator.
 *
 * The unit, and why it is blocks rather than minutes
 * -------------------------------------------------
 * One credit per **started 5-minute block**, and the
 * **first block is included**
 * in the `machines.deploy` charge the session already paid. Five minutes is not
 * arbitrary: the paid idle deadline is 15 minutes, so a full idle cycle
 * is three
 * blocks, which bounds an abandoned session without a separate rule.
 *
 * The ceiling is 20 **metered** credits, and it is separate from the 5-credit
 * deploy charge — a session created and then abandoned with the reaper down
 * therefore tops out at 25 credits, not 20. Stating that plainly because the
 * earlier roadmap note conflated the two, and the difference is 5 credits of
 * real money.
 *
 * Why charging is per BLOCK and not per delta
 * -------------------------------------------
 * `consumeBillingCredits` writes a ledger document whose id is derived from
 * `idempotencyKey`, and `applyBillingCreditMutation` returns unchanged
 * when that document already exists (`app/billing-credits.ts:103`).
 * So a charge keyed
 * `bs-meter:<sessionId>:block:<n>` is applied **at most once, ever** — a retry,
 * an overlapping run, or a crash between the charge and the counter write are
 * all no-ops on the second attempt. That is why this module returns the *keys*
 * to charge rather than a single delta: the keys are what make it safe, and they
 * make a missed run self-healing on the next one.
 */
import type {BrowserTier} from "./browser-session.domain"
import type {ComputeSource} from "./byo-compute.domain"

/** Minutes per billed block. Pinned: the rate is "1 credit per started 5 min". */
export const METER_BLOCK_MINUTES = 5

/**
 * The most a single session may be charged in **metered** credits.
 *
 * Bounds an abandoned session whose machine never got reaped. It does not
 * include the `machines.deploy` charge, which is taken at creation and is not
 * this module's business.
 */
export const METER_MAX_CREDITS_PER_SESSION = 20

/** The ledger key prefix. Kept here so the writer and any audit agree. */
export const METER_LEDGER_SOURCE = "browser-session-meter"

/**
 * Minutes of platform browser time that have accrued.
 *
 * The window ends at the EARLIEST of: now, the idle deadline, and the moment the
 * session was closed. The idle deadline matters most — past it the machine is
 * suspended, so no compute is accruing and billing it would charge for a machine
 * that is not running. A tier with no idle deadline (`free`, `admin`) supplies
 * none, which is why `expiredAt` is optional rather than defaulted to a number.
 * @param {number} createdAt Epoch ms the session was created.
 * @param {number} now Epoch ms the sweep is running at.
 * @param {number|undefined} expiredAt The idle deadline, when the tier has one.
 * @param {number|undefined} closedAt When the session was closed, if it was.
 * @return {number} Whole minutes elapsed, never negative.
 */
export const billableMinutes = (
  createdAt: number,
  now: number,
  expiredAt?: number,
  closedAt?: number
): number => {
  const end = Math.min(
    now,
    typeof expiredAt === "number" ? expiredAt : now,
    typeof closedAt === "number" ? closedAt : now
  )
  const elapsedMs = end - createdAt
  return elapsedMs > 0 ? Math.floor(elapsedMs / 60_000) : 0
}

/**
 * How many blocks have been started within `minutes`.
 *
 * `ceil`, because a started block is a billed block: 1 minute into the second
 * block is not a reason to call it the first.
 * @param {number} minutes Whole minutes elapsed.
 * @return {number} Blocks started, never negative.
 */
export const meterBlocks = (minutes: number): number =>
  minutes > 0 ? Math.ceil(minutes / METER_BLOCK_MINUTES) : 0

/**
 * Total metered credits owed for `minutes`, after the included block.
 *
 * The first block is free because `machines.deploy` already charged for the
 * session's creation; charging it again here would bill the same five minutes
 * twice. Capped at the ceiling, so this is a function of total elapsed time and
 * not of anything the caller has to keep in step with.
 * @param {number} minutes Whole minutes elapsed.
 * @return {number} Credits owed in total, between 0 and the ceiling.
 */
export const meterCreditsFor = (minutes: number): number => {
  const billable = meterBlocks(minutes) - 1
  if (billable <= 0) {
    return 0
  }
  return Math.min(billable, METER_MAX_CREDITS_PER_SESSION)
}

/**
 * Whether a session has used its whole metered allowance.
 *
 * This is the trigger for ENDING a session, and it exists because the ceiling
 * on its own does not bound compute. `meterChargeFor` stops emitting keys at the
 * ceiling, so past that block the session keeps running and is billed nothing: an
 * invoice cap, not a cost control. A caller that keeps calling `keepalive`
 * therefore rides free, and while the loss per tenant is bounded it is real and
 * it multiplies with the number of callers.
 *
 * The ceiling is treated as the session's LIFETIME as well as its price, and the
 * two are the same number on purpose. A separate lifetime field would need its
 * own value and its own account of where that value came from, and its
 * relationship to the price cap would be a thing to keep in step. The ceiling is
 * already the amount the customer agreed to spend, which makes it the honest
 * place to stop.
 * @param {number} minutes Whole minutes elapsed.
 * @return {boolean} True once the last billable block has finished.
 */
export const isMeterExhausted = (minutes: number): boolean =>
  // Off by one on purpose, and it is not the same test as "no credit is due".
  // Credits stop accruing one minute INTO block 21, because a started block is a
  // billed block. Ending the session there would cut off a block the customer has
  // already been charged for. So this fires only once block 21 is done, which is
  // the point at which nothing further can be billed AND nothing remains owed.
  meterBlocks(minutes) > METER_MAX_CREDITS_PER_SESSION + 1

/**
 * A session is only metered when the PLATFORM provided the compute.
 *
 * There are two independent reasons it is not ours to bill, and they are not the
 * same question:
 *
 *  - `computeSource: "byo"` — the machine exists, but in the CALLER's Fly
 *    organization. They pay Fly directly, so charging here double-bills them.
 *  - no `machineId` — nothing was provisioned at all, which is what a BYO CDP
 *    session looks like. There is no machine we could have run.
 *
 * `machineId` alone used to answer both, because a BYO-CDP session was the only
 * session with no machine. Moving compute into the caller's organization made
 * the two diverge: a BYO-COMPUTE session HAS a machine id, so the presence test
 * would have billed platform compute for a machine the platform never ran. Both
 * tests therefore live here rather than one of them being left to a caller.
 * @param {object} session The two facts the decision needs.
 * @param {string} [session.machineId] The platform machine, when there is one.
 * @param {ComputeSource} [session.computeSource] Whose organization ran it.
 * @return {boolean} True when browser time is billable.
 */
export const isMeterBillable = (session: {
  machineId?: string
  computeSource?: ComputeSource
}): boolean => {
  if (session.computeSource === "byo") {
    return false
  }

  return typeof session.machineId === "string" && session.machineId.length > 0
}

/**
 * Which tiers are metered.
 *
 * `free` never receives a dedicated machine, so there is nothing to meter — and
 * `admin` is the operator. Both are listed explicitly rather than left to a
 * `!== "paid"` check, so adding a tier forces a decision here instead of
 * silently inheriting one.
 * @param {BrowserTier} tier The session's tier.
 * @return {boolean} True when the tier is billed for time.
 */
export const isMeteredTier = (tier: BrowserTier): boolean => tier === "paid"

/**
 * What a sweep should charge for one session.
 */
export interface MeterCharge {
  /** Credits owed in total for the session's elapsed time, after the ceiling. */
  creditsOwed: number
  /** Blocks started, including the included one. */
  blocks: number
  /**
   * Ledger idempotency keys for the blocks that are not yet billed. Each is
   * worth exactly one credit, and each is applied at most once however many
   * times a sweep repeats.
   */
  keys: string[]
}

/**
 * The charge for one session, given what it was last billed.
 *
 * Returns KEYS rather than a delta so the caller cannot charge the same block
 * twice: the idempotency key is what enforces that, and it survives a crash
 * between the charge and the write of `minutesBilled`. A run that dies after
 * charging block 4 and before recording it re-derives the same key next time
 * and is a no-op — the meter heals itself instead of needing to know it failed.
 *
 * No keys are returned once the ceiling is reached, which is what makes the
 * ceiling a real bound rather than an arithmetic clamp that the ledger would
 * keep re-attempting.
 * @param {string} sessionId The session, for the key's uniqueness.
 * @param {number} minutes Whole minutes elapsed now.
 * @param {number} minutesBilled The value persisted by the last sweep.
 * @return {MeterCharge} Total owed, blocks started, and the keys to charge.
 */
export const meterChargeFor = (
  sessionId: string,
  minutes: number,
  minutesBilled: number
): MeterCharge => {
  const blocks = meterBlocks(minutes)
  const already = meterBlocks(Math.max(0, minutesBilled))
  const creditsOwed = meterCreditsFor(minutes)

  // Block 1 is included in `machines.deploy`, so billing starts at block 2. And
  // block n is credit n-1, so the ceiling of 20 credits is reached at block 21:
  // capping the block index is the same statement as capping the credits, and
  // doing it here is what stops the ledger being re-attempted past the ceiling
  // on every later sweep.
  const firstBlock = Math.max(2, already + 1)
  const lastBlock = Math.min(blocks, METER_MAX_CREDITS_PER_SESSION + 1)

  const keys: string[] = []
  for (let block = firstBlock; block <= lastBlock; block++) {
    keys.push(`bs-meter:${sessionId}:block:${block}`)
  }

  return {creditsOwed, blocks, keys}
}
