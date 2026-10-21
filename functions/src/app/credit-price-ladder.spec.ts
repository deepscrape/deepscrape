/* eslint-disable max-len */
/**
 * The credit ladder, asserted instead of remembered.
 *
 * Every price in this table is a ratio between two numbers, and both move: the pack amounts
 * changed once already (19 / 79 / 249 to 1.50 / 6.00 / 20.00) because a pack buyer was paying
 * 76x what a subscriber paid for the same unit. Nothing failed when that was true, because the
 * numbers were only ever checked by a person reading them.
 *
 * These three rules are what a person would check, written down once. They are ratios rather
 * than amounts on purpose: a ratio survives a retier, and an amount does not.
 *
 * Nothing here encodes a cost model. The marginal cost of a credit (~EUR0.0014, from a
 * machine-minute at EUR0.000306) is an input to choosing these numbers, not a thing this test
 * can verify -- and a cost model hardcoded in a spec would be wrong within a month and then
 * trusted, which is worse than absent.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {billingPlanCatalog, creditPackCatalog} from "./stripe"

/**
 * Euros per credit for a plan interval, or null when it has no price.
 * @param {string} plan The plan id.
 * @param {string} interval The interval to price.
 * @return {number|null} Euros per credit, or null when the interval is not sold.
 */
const planRate = (plan: string, interval: "monthly" | "quarterly" | "annually"): number | null => {
  const entry = billingPlanCatalog.find((item) => item.id === plan)?.prices[interval]
  const credits = entry?.includedCredits || 0

  if (!entry || credits <= 0 || entry.amount <= 0) {
    return null
  }

  return entry.amount / credits / 100
}

const packRate = (id: string): number => {
  const pack = creditPackCatalog.find((item) => item.id === id)
  assert.ok(pack, `no pack ${id}`)
  return pack.amount / pack.credits / 100
}

describe("credit price ladder", () => {
  it("never sells a pack cheaper than the best subscription rate", () => {
    // A pack is "no commitment" and should cost MORE per credit than a plan. Costing less
    // means nobody subscribes, which is the D2 defect with the sign flipped.
    const bestPlan = planRate("pro", "monthly")
    assert.ok(bestPlan !== null)

    for (const pack of creditPackCatalog) {
      assert.ok(
        packRate(pack.id) >= bestPlan,
        `${pack.id} is EUR${packRate(pack.id).toFixed(4)}/credit, below pro's EUR${bestPlan.toFixed(4)}`,
      )
    }
  })

  it("keeps the no-commitment premium under 2x the cheapest plan", () => {
    // The original spread was 40-76x. A premium is legible; a multiple is not.
    const cheapest = planRate("starter", "monthly")
    assert.ok(cheapest !== null)

    for (const pack of creditPackCatalog) {
      assert.ok(
        packRate(pack.id) <= cheapest * 2,
        `${pack.id} is ${(packRate(pack.id) / cheapest).toFixed(1)}x starter, over the 2x ceiling`,
      )
    }
  })

  it("prices the unlimited tier at least double the tier below it", () => {
    // Unlimited request-priced work has no ceiling, so an Enterprise fee that undercuts Pro
    // twice over would let anyone spend more than they pay by upgrading.
    const pro = billingPlanCatalog.find((item) => item.id === "pro")?.prices.monthly?.amount ?? 0
    const enterprise = billingPlanCatalog.find((item) => item.id === "enterprise")?.prices.monthly?.amount ?? 0

    assert.ok(pro > 0 && enterprise > 0)
    assert.ok(enterprise >= pro * 2, `enterprise EUR${enterprise} is under 2x pro's EUR${pro}`)
  })

  it("does not discount an interval below the monthly rate", () => {
    // A longer term is a commitment discount, so it may be cheaper per month -- but never
    // free, and never so cheap that the annual is a second monthly.
    for (const plan of ["starter", "pro", "enterprise"] as const) {
      const monthly = planRate(plan, "monthly")
      const annual = planRate(plan, "annually")
      assert.ok(monthly !== null && annual !== null)

      assert.ok(annual < monthly, `${plan}: annual should cost less per credit than monthly`)
      assert.ok(annual > monthly / 2, `${plan}: annual is under half the monthly rate`)
    }
  })
})
