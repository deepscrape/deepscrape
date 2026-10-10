/* eslint-disable max-len */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  decideSpend,
  freeAllowanceRemaining,
  periodStart,
} from "./billing-policy.domain"
import type {SpendWindow} from "./billing-policy.domain"

/**
 * What is worth pinning here is not the arithmetic — it is the two decisions a
 * reader would otherwise have to trust: that "no cap" and "an unreadable
 * counter" are DIFFERENT (one allows, one refuses), and that landing exactly
 * on the cap is allowed.
 */
describe("decideSpend", () => {
  const window = (spentCredits: number): SpendWindow => ({
    periodStartMs: 0,
    spentCredits,
  })

  it("allows anything when no cap is configured", () => {
    const decision = decideSpend(undefined, window(1_000_000), 500)
    assert.equal(decision.allowed, true)
  })

  it("does not refuse a capless customer when the counter is unreadable", () => {
    // The whole reason `window` is optional: a Redis blip must not take the
    // free tier down for customers who never set a cap.
    const decision = decideSpend({}, undefined, 500)
    assert.equal(decision.allowed, true)
  })

  it("refuses when a cap is set and the counter cannot be read", () => {
    // Fail closed. This is the highest-risk line of the pricing model.
    const decision = decideSpend({spendCapCredits: 5000}, undefined, 1)
    if (decision.allowed) {
      assert.fail("expected a refusal")
    }
    assert.equal(decision.reason, "cap-unreadable")
  })

  it("treats a zero cap as no cap, not as a cap of zero", () => {
    // A zero cap would otherwise refuse every request silently.
    const decision = decideSpend({spendCapCredits: 0}, window(0), 1)
    assert.equal(decision.allowed, true)
  })

  it("allows a charge that lands exactly on the cap", () => {
    const decision = decideSpend({spendCapCredits: 5000}, window(4500), 500)
    assert.equal(decision.allowed, true)
  })

  it("refuses a charge one credit past the cap", () => {
    const decision = decideSpend({spendCapCredits: 5000}, window(4500), 501)
    if (decision.allowed) {
      assert.fail("expected a refusal")
    }
    assert.equal(decision.reason, "budget")
  })

  it("refuses once the counter is already at the cap", () => {
    const decision = decideSpend({spendCapCredits: 5000}, window(5000), 1)
    assert.equal(decision.allowed, false)
  })

  it("reports degrade only when the customer asked for it", () => {
    const policy = {spendCapCredits: 5000, onExhaust: "degrade" as const}
    const decision = decideSpend(policy, window(0), 1)
    if (!decision.allowed) {
      assert.fail("expected an allowance")
    }
    assert.equal(decision.degrade, true)
  })

  it("never reports degrade on a refusal", () => {
    const policy = {spendCapCredits: 5000, onExhaust: "degrade" as const}
    const decision = decideSpend(policy, window(9000), 1)
    assert.equal(decision.allowed, false)
  })
})

describe("periodStart", () => {
  it("resolves a day window to UTC midnight", () => {
    const noon = Date.UTC(2026, 9, 4, 12, 30)
    assert.equal(periodStart(noon, "day"), Date.UTC(2026, 9, 4))
  })

  it("resolves a month window to the first, in UTC", () => {
    const midMonth = Date.UTC(2026, 9, 4, 12, 30)
    assert.equal(periodStart(midMonth, "month"), Date.UTC(2026, 9, 1))
  })

  it("does not move a day boundary across a timezone", () => {
    // 23:30 UTC is already the next day in most of Europe, and the period must
    // not follow the customer's clock.
    const late = Date.UTC(2026, 9, 4, 23, 30)
    assert.equal(periodStart(late, "day"), Date.UTC(2026, 9, 4))
  })
})

describe("freeAllowanceRemaining", () => {
  it("subtracts calls already spent", () => {
    assert.equal(freeAllowanceRemaining({dailyFreeCredits: 10}, 4), 6)
  })

  it("clamps at zero rather than going negative", () => {
    assert.equal(freeAllowanceRemaining({dailyFreeCredits: 10}, 14), 0)
  })

  it("returns zero when no allowance is configured", () => {
    assert.equal(freeAllowanceRemaining({}, 0), 0)
  })
})
