/* eslint-disable max-len */
/**
 * Pins the metering rate for platform browser time (`§1.6`).
 *
 * Two cases carry the weight, and both are about money rather than behaviour.
 *
 * The first is the FREE BLOCK. `machines.deploy` charges 5 credits when the
 * session is created, and that charge is meant to cover the first five minutes.
 * If the first block were billed here as well, every paid session would be
 * charged twice for the same five minutes -- a systematic overcharge, not an
 * edge case, which is why the boundary at exactly one block is asserted instead
 * of assumed.
 *
 * The second is IDEMPOTENCE UNDER RETRY, which is the reason the rate logic
 * returns ledger keys instead of an amount. `applyBillingCreditMutation` treats
 * a re-used `idempotencyKey` as already applied, so a sweep that crashes after
 * charging block 4 and before recording it must re-derive that same key and be
 * a no-op. The alternative -- charging a delta of
 * `creditsOwed(now) - creditsOwed(stored)` -- would be correct arithmetic and
 * would still double-charge in exactly that window, because the stored counter
 * is the thing that did not get written. Asserted by charging twice and
 * demanding the second pass find nothing to do.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  METER_BLOCK_MINUTES,
  METER_MAX_CREDITS_PER_SESSION,
  billableMinutes,
  isMeterBillable,
  isMeteredTier,
  isMeterExhausted,
  meterBlocks,
  meterChargeFor,
  meterCreditsFor,
} from "./browser-meter.domain"

/** A fixed instant, so no test depends on the wall clock. */
const T0 = 1_700_000_000_000
const minutes = (n: number): number => T0 + n * 60_000

describe("billableMinutes", () => {
  it("counts whole minutes since creation", () => {
    assert.equal(billableMinutes(T0, minutes(7)), 7)
  })

  it("rounds DOWN, so a partial minute is not billed", () => {
    assert.equal(billableMinutes(T0, T0 + 59_999), 0)
  })

  it("is zero for a session created this instant", () => {
    assert.equal(billableMinutes(T0, T0), 0)
  })

  it("is zero rather than negative when the clock disagrees", () => {
    // A sweep racing a clock skew must not produce a negative duration and
    // thereby a negative number of blocks to charge for.
    assert.equal(billableMinutes(T0, T0 - 60_000), 0)
  })

  it("stops at the idle deadline, because the machine is suspended there", () => {
    // 20 minutes have passed but the deadline fell at 15, so the machine has
    // only run for 15. Billing the rest would charge for a suspended machine.
    assert.equal(billableMinutes(T0, minutes(20), minutes(15)), 15)
  })

  it("ignores the idle deadline while it is still in the future", () => {
    assert.equal(billableMinutes(T0, minutes(4), minutes(15)), 4)
  })

  it("stops at the moment the session was closed", () => {
    assert.equal(billableMinutes(T0, minutes(20), minutes(15), minutes(9)), 9)
  })
})

describe("meterBlocks", () => {
  it("is zero before any time has passed", () => {
    assert.equal(meterBlocks(0), 0)
  })

  it("counts a STARTED block, not a completed one", () => {
    assert.equal(meterBlocks(1), 1)
    assert.equal(meterBlocks(METER_BLOCK_MINUTES), 1)
    assert.equal(meterBlocks(METER_BLOCK_MINUTES + 1), 2)
  })
})

describe("meterCreditsFor", () => {
  it("charges nothing inside the first block", () => {
    assert.equal(meterCreditsFor(0), 0)
    assert.equal(meterCreditsFor(4), 0)
  })

  it("charges nothing for exactly one block, which deploy already covered", () => {
    assert.equal(meterCreditsFor(5), 0)
  })

  it("charges one credit one minute into the second block", () => {
    assert.equal(meterCreditsFor(6), 1)
  })

  it("charges one credit per block after the first", () => {
    assert.equal(meterCreditsFor(15), 2)
    assert.equal(meterCreditsFor(30), 5)
  })

  it("stops at the ceiling rather than growing without bound", () => {
    // 21 blocks -> 20 credits billed, the last one emitted is block 21.
    assert.equal(meterCreditsFor(105), METER_MAX_CREDITS_PER_SESSION)
    assert.equal(meterCreditsFor(200), METER_MAX_CREDITS_PER_SESSION)
    assert.equal(meterCreditsFor(100_000), METER_MAX_CREDITS_PER_SESSION)
  })
})

describe("meterChargeFor", () => {
  it("finds nothing to charge for a brand-new session", () => {
    const charge = meterChargeFor("s1", 0, 0)
    assert.equal(charge.creditsOwed, 0)
    assert.deepEqual(charge.keys, [])
  })

  it("finds nothing to charge while the included block is still running", () => {
    assert.deepEqual(meterChargeFor("s1", 5, 0).keys, [])
  })

  it("emits exactly one key per newly-started block", () => {
    const charge = meterChargeFor("s1", 11, 0)
    assert.equal(charge.blocks, 3)
    assert.equal(charge.creditsOwed, 2)
    assert.deepEqual(charge.keys, [
      "bs-meter:s1:block:2",
      "bs-meter:s1:block:3",
    ])
  })

  it("never emits a key for the included first block", () => {
    assert.ok(!meterChargeFor("s1", 11, 0).keys.includes("bs-meter:s1:block:1"))
  })

  it("charges only the blocks added since the last recorded minutes", () => {
    // 6 minutes was already billed; two more blocks have since started.
    const charge = meterChargeFor("s1", 16, 6)
    assert.deepEqual(charge.keys, [
      "bs-meter:s1:block:3",
      "bs-meter:s1:block:4",
    ])
  })

  it("is IDEMPOTENT: a repeated sweep finds nothing to charge", () => {
    const first = meterChargeFor("s1", 16, 0)
    // 16 minutes is four started blocks (0-5, 5-10, 10-15, 15-20); the first is
    // included, so three are billable.
    assert.deepEqual(first.keys, [
      "bs-meter:s1:block:2",
      "bs-meter:s1:block:3",
      "bs-meter:s1:block:4",
    ])

    // The sweep ran again with the same elapsed time. Whether or not the caller
    // managed to persist `minutesBilled`, no second charge may be produced.
    const second = meterChargeFor("s1", 16, 16)
    assert.deepEqual(second.keys, [])
    assert.deepEqual(meterChargeFor("s1", 16, 0).keys, first.keys)
  })

  it("re-derives the SAME key after a crash between charge and write", () => {
    // This is the property that makes a lost write safe: the key is a function
    // of the block index alone, so the retry collides with the ledger document
    // the first attempt created and is treated as already applied.
    const crashed = meterChargeFor("s1", 21, 0)
    const retried = meterChargeFor("s1", 21, 0)
    assert.deepEqual(retried.keys, crashed.keys)
    // 21 minutes is five started blocks, four billable.
    assert.deepEqual(crashed.keys, [
      "bs-meter:s1:block:2",
      "bs-meter:s1:block:3",
      "bs-meter:s1:block:4",
      "bs-meter:s1:block:5",
    ])
  })

  it("namespaces keys by session, so two sessions cannot collide", () => {
    assert.notDeepEqual(
      meterChargeFor("a", 11, 0).keys,
      meterChargeFor("b", 11, 0).keys
    )
  })

  it("stops emitting keys at the ceiling and never exceeds it", () => {
    // A session abandoned with the reaper down: 10 hours elapsed.
    const charge = meterChargeFor("s1", 600, 0)
    assert.equal(charge.keys.length, METER_MAX_CREDITS_PER_SESSION)
    assert.equal(charge.creditsOwed, METER_MAX_CREDITS_PER_SESSION)
    assert.equal(charge.keys.at(-1), "bs-meter:s1:block:21")
  })

  it("emits no keys past the ceiling on a later sweep", () => {
    // Already at the cap, and another hour has passed.
    assert.deepEqual(meterChargeFor("s1", 660, 600).keys, [])
  })

  it("counts the ceiling per session, not across sessions", () => {
    const a = meterChargeFor("a", 600, 0)
    const b = meterChargeFor("b", 600, 0)
    assert.equal(a.keys.length, METER_MAX_CREDITS_PER_SESSION)
    assert.equal(b.keys.length, METER_MAX_CREDITS_PER_SESSION)
  })

  it("tolerates a recorded value that is not on a block boundary", () => {
    // `minutesBilled` is minutes, but the arithmetic works in blocks, so a
    // stored 7 must behave as the two blocks it necessarily spans.
    assert.deepEqual(meterChargeFor("s1", 11, 7).keys, ["bs-meter:s1:block:3"])
  })
})

describe("isMeterBillable", () => {
  it("is false for a BYO session, which was given no platform machine", () => {
    // Nothing was provisioned, so charging minutes would bill a customer for
    // compute the platform never supplied.
    assert.equal(isMeterBillable(undefined), false)
  })

  it("is false for an empty machine id, which is not a provisioned machine", () => {
    assert.equal(isMeterBillable(""), false)
  })

  it("is true when the platform provided a machine", () => {
    assert.equal(isMeterBillable("d8912345"), true)
  })
})

describe("isMeteredTier", () => {
  it("meters the paid tier", () => {
    assert.equal(isMeteredTier("paid"), true)
  })

  it("does not meter the free tier, which has no dedicated machine", () => {
    assert.equal(isMeteredTier("free"), false)
  })

  it("does not meter the operator", () => {
    assert.equal(isMeteredTier("admin"), false)
  })
})

describe("isMeterExhausted", () => {
  it("is false while there is still credit to bill", () => {
    assert.equal(isMeterExhausted(0), false)
    assert.equal(isMeterExhausted(100), false)
  })

  it("does NOT fire while the last paid block is still running", () => {
    // Block 21 is the last one billed, and it runs from 100 to 105 minutes. The
    // credit is charged the moment that block STARTS. Ending the session at 101
    // would cut off a block the customer has already paid for, so this must stay
    // false until the block is done. This boundary was wrong on the first pass.
    assert.equal(isMeterExhausted(105), false)
  })

  it("fires once that block is done and nothing further can be billed", () => {
    assert.equal(isMeterExhausted(106), true)
  })

  it("stays true afterwards, so a late sweep cannot revive a session", () => {
    assert.equal(isMeterExhausted(600), true)
    assert.equal(isMeterExhausted(100_000), true)
  })

  it("agrees with the block the charge arithmetic stops at", () => {
    // `meterChargeFor` emits its last key for block 21, so the ceiling is
    // reached at 101 minutes and held to 105. Nothing else would notice the two
    // drifting apart, and the gap would be compute the platform pays for and
    // nobody is billed for.
    assert.equal(meterCreditsFor(100), METER_MAX_CREDITS_PER_SESSION - 1)
    assert.equal(meterCreditsFor(101), METER_MAX_CREDITS_PER_SESSION)
    assert.equal(meterCreditsFor(105), METER_MAX_CREDITS_PER_SESSION)
  })
})
