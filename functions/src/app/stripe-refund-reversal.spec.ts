/* eslint-disable max-len */
/**
 * The refund reversal is the only payment path that *removes* credits, and getting it wrong is
 * silent in both directions: too small and a refunded customer keeps credits they were paid
 * back for, too large and the ledger mutation throws, failing the webhook for Stripe to retry
 * forever. Both directions are pinned here, against the real function.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {computeRefundCreditReversal} from "./stripe"

const charge = (amount: number, amountRefunded: number) => ({amount, amount_refunded: amountRefunded})

/**
 * refund reversal
 */
describe("computeRefundCreditReversal", () => {
  it("reverses every credit on a full refund", () => {
    assert.equal(computeRefundCreditReversal(charge(1900, 1900), 100, 100), 100)
  })

  it("reverses pro-rata on a partial refund", () => {
    // Half the money back, half the credits back.
    assert.equal(computeRefundCreditReversal(charge(1900, 950), 100, 100), 50)
  })

  it("clamps to what is still available so the ledger never goes negative", () => {
    // 100 granted, 60 already spent, full refund: only the 40 left can come back.
    assert.equal(computeRefundCreditReversal(charge(1900, 1900), 100, 40), 40)
  })

  it("floors a fractional reversal rather than over-taking", () => {
    assert.equal(computeRefundCreditReversal(charge(24900, 100), 2000, 2000), 8)
  })

  it("reverses nothing without a refund, an amount or a credit grant", () => {
    assert.equal(computeRefundCreditReversal(charge(1900, 0), 100, 100), 0)
    assert.equal(computeRefundCreditReversal(charge(0, 0), 100, 100), 0)
    // A subscription charge bought no pack, so there is nothing to take back.
    assert.equal(computeRefundCreditReversal(charge(1999, 1999), 0, 500), 0)
  })

  it("never takes back more than was granted", () => {
    assert.equal(computeRefundCreditReversal(charge(1900, 3800), 100, 100), 100)
  })
})
