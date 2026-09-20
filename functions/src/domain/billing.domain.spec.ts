/* eslint-disable max-len */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  canPurchaseStandaloneCredits,
  computeBillingMetrics,
  getBillingAccessMode,
  getIncludedCreditsAvailable,
  getPurchasedCreditsAvailable,
  hasBillingAccess,
  isPaidPlan,
  monthlyRecurringAmountEur,
  normalizeBillingPlan,
} from "./billing.domain"

describe("billing.domain", () => {
  it("monthlyRecurringAmountEur normalises each interval and drops one-offs", () => {
    assert.equal(monthlyRecurringAmountEur(999, "monthly"), 999)
    assert.equal(monthlyRecurringAmountEur(2799, "quarterly"), 933)
    assert.equal(monthlyRecurringAmountEur(9999, "annually"), 833.25)

    // A credit pack is not recurring revenue, and unknown shapes never count.
    assert.equal(monthlyRecurringAmountEur(1900, "payAsYouGo"), 0)
    assert.equal(monthlyRecurringAmountEur(999, null), 0)
    assert.equal(monthlyRecurringAmountEur(999, "weekly"), 0)
    assert.equal(monthlyRecurringAmountEur(-999, "monthly"), 0)
    assert.equal(monthlyRecurringAmountEur("not-a-number", "monthly"), 0)
  })

  it("computeBillingMetrics counts MRR, trials and payment risk separately", () => {
    const now = Date.parse("2026-09-18T00:00:00Z")
    const prices: Record<string, number> = {
      "starter:monthly": 999,
      "starter:quarterly": 2799,
      "pro:monthly": 1999,
      "pro:annually": 19999,
    }
    const priceFor = (plan: string, interval: string): number => prices[`${plan}:${interval}`] ?? 0

    const metrics = computeBillingMetrics([
      {plan: "starter", planInterval: "monthly", status: "active"},
      {plan: "pro", planInterval: "annually", status: "active"},
      // Past due still bills, so it stays in MRR -- and is counted as risk.
      {plan: "starter", planInterval: "quarterly", status: "past_due"},
      {
        plan: "trial",
        status: "trialing",
        trialEndsAt: "2026-09-25T00:00:00Z",
        trialPlanTarget: "pro",
      },
      // Expired trial: no longer an active trial, and contributes nothing.
      {plan: "trial", status: "trialing", trialEndsAt: "2026-09-01T00:00:00Z", trialPlanTarget: "pro"},
      {plan: "starter", planInterval: "monthly", status: "canceled"},
      {plan: "free"},
    ], priceFor as never, now)

    assert.equal(metrics.payingAccounts, 3, "canceled and free are not paying accounts")
    assert.equal(metrics.pastDueAccounts, 1)
    assert.equal(metrics.activeTrials, 1, "an expired trial is not active")
    assert.equal(metrics.trialPipelineEurMinor, 1999, "trial pipeline prices the target plan monthly")
    assert.deepEqual(metrics.planMix, {starter: 3, pro: 1, trial: 2, free: 1})

    // 999 + 19999/12 + 933, rounded once at the sum.
    assert.equal(Math.round(metrics.mrrEurMinor), 3599)
  })

  it("computeBillingMetrics treats a missing status as paying", () => {
    const legacy = computeBillingMetrics(
      [{plan: "starter", planInterval: "monthly"}],
      (() => 999) as never,
      Date.parse("2026-09-18T00:00:00Z"),
    )

    assert.equal(legacy.payingAccounts, 1, "rows written before `status` existed are still subscriptions")
    assert.equal(Math.round(legacy.mrrEurMinor), 999)
  })

  it("normalizeBillingPlan falls back unknown plans to free", () => {
    assert.equal(normalizeBillingPlan("starter"), "starter")
    assert.equal(normalizeBillingPlan("garbage"), "free")
    assert.equal(normalizeBillingPlan(null), "free")
    assert.equal(normalizeBillingPlan(undefined), "free")
  })

  it("isPaidPlan is true only for paid tiers", () => {
    assert.equal(isPaidPlan("trial"), true)
    assert.equal(isPaidPlan("starter"), true)
    assert.equal(isPaidPlan("enterprise"), true)
    assert.equal(isPaidPlan("free"), false)
    assert.equal(isPaidPlan("unknown"), false)
  })

  it("derives purchased and included credits from dedicated fields", () => {
    const billing = {
      plan: "free",
      credits: {
        purchasedBalance: 120,
        purchasedReserved: 20,
        includedBalance: 35,
        includedReserved: 5,
      },
    }

    assert.equal(getPurchasedCreditsAvailable(billing), 100)
    assert.equal(getIncludedCreditsAvailable(billing), 30)
  })

  it("supports legacy credit fields for free and paid plans", () => {
    const legacyFree = {
      plan: "free",
      credits: {
        balance: 30,
        reserved: 5,
      },
    }
    const legacyPaid = {
      plan: "pro",
      credits: {
        balance: 40,
        reserved: 10,
      },
    }

    assert.equal(getPurchasedCreditsAvailable(legacyFree), 25)
    assert.equal(getIncludedCreditsAvailable(legacyFree), 0)
    assert.equal(getPurchasedCreditsAvailable(legacyPaid), 0)
    assert.equal(getIncludedCreditsAvailable(legacyPaid), 30)
  })

  it("returns access mode by priority: plan > credits > grace > free", () => {
    const now = Date.UTC(2026, 2, 19)

    assert.equal(getBillingAccessMode({plan: "pro"}, now), "plan")
    assert.equal(
      getBillingAccessMode({plan: "free", credits: {purchasedBalance: 10}}, now),
      "credits",
    )
    assert.equal(
      getBillingAccessMode({plan: "free", graceUntil: "2099-01-01T00:00:00.000Z"}, now),
      "grace",
    )
    assert.equal(getBillingAccessMode({plan: "free"}, now), "free")
  })

  it("hasBillingAccess is false only for free mode", () => {
    const now = Date.UTC(2026, 2, 19)

    assert.equal(hasBillingAccess({plan: "starter"}, now), true)
    assert.equal(hasBillingAccess({plan: "free", credits: {purchasedBalance: 2}}, now), true)
    assert.equal(hasBillingAccess({plan: "free"}, now), false)
  })

  it("canPurchaseStandaloneCredits requires free plan without subscription", () => {
    assert.equal(canPurchaseStandaloneCredits({plan: "free"}), true)
    assert.equal(canPurchaseStandaloneCredits({plan: "free", subscriptionId: "sub_123"}), false)
    assert.equal(canPurchaseStandaloneCredits({plan: "pro"}), false)
  })
})
