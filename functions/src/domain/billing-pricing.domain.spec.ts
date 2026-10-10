/* eslint-disable max-len */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  estimateBillingCost,
  getBillingPricingRules,
  getDefaultPricingRate,
  getPublicPricingRates,
  resolveBillingPricingPolicy,
} from "./billing-pricing.domain"

/**
 * These specs are written against INVARIANTS rather than against the literal
 * numbers, because `activeRules` is `BILLING_PRICING_RULES_JSON` when that env var
 * is set. A test that asserted `crawl.execute === 3` would pass in one environment
 * and fail in another for no reason; a test that says "the page shows what the
 * resolver charges" is the property that actually has to hold, in every
 * environment.
 */
describe("billing-pricing.domain", () => {
  it("publishes exactly the table it charges from", () => {
    // Derived, not restated. If someone adds a rule and forgets the page, this is
    // what fails.
    const internal = getBillingPricingRules()
    const published = getPublicPricingRates()

    assert.equal(published.length, internal.length)
    internal.forEach((rule, index) => {
      assert.equal(published[index].action, rule.policy.action)
      assert.equal(published[index].credits, rule.policy.credits)
      assert.equal(published[index].method, rule.method)
    })
  })

  it("never publishes the route pattern", () => {
    // The patterns describe our internal routing (`^/machines/machine/[^/]+$`).
    // A pricing surface has no use for them, so shipping them would publish the
    // route table for no benefit.
    const published = getPublicPricingRates()
    published.forEach((rate) => {
      assert.equal("pattern" in rate, false)
    })
    assert.equal(JSON.stringify(published).includes("^/"), false)
  })

  it("shows the number that is actually charged for a real route", () => {
    // THE anti-drift assertion. Whatever the resolver charges for a crawl has to
    // be published for that same action, or the page advertises a price the code
    // does not honour. Env-independent on purpose: it compares the two sources to
    // each other, not to a literal.
    const policy = resolveBillingPricingPolicy("POST", "/crawl")
    const match = getPublicPricingRates().find(
      (rate) => rate.action === policy.action,
    )

    assert.ok(match, `a charged action must be published: ${policy.action}`)
    assert.equal(match.credits, policy.credits)
  })

  it("covers machine actions, which is where the money is", () => {
    const policy = resolveBillingPricingPolicy(
      "PUT",
      "/machines/machine/abc123/start",
    )
    const match = getPublicPricingRates().find(
      (rate) => rate.action === policy.action,
    )

    assert.ok(match, `a charged action must be published: ${policy.action}`)
    assert.equal(match.credits, policy.credits)
  })

  it("prices every crawl entry point the same, and charges nothing to read one", () => {
    // Regression, 2026-10-10. Only `^/crawl$` was listed, so the streaming and
    // seeder enqueues matched no rule and fell through to `api.paid.default` -- 1
    // credit, while the rates page advertised `crawl.execute` at 3. The same
    // fallback caught the status routes, which billed 1 credit PER POLL: a customer
    // was charged for watching a job they had already paid to enqueue, and the
    // longer it ran the more the watching cost.
    const enqueues = [
      "/crawl",
      "/crawl/stream/job",
      "/seeder/stream/job/multi-research",
    ]
    enqueues.forEach((path) => {
      const policy = resolveBillingPricingPolicy("POST", path)
      assert.equal(policy.action, "crawl.execute", `${path} must price as a crawl`)
      assert.equal(policy.credits, 3, `${path} must cost the published rate`)
    })

    const reads = [
      "/job/stream/status/task-1",
      "/crawl/stream/job/status/task-1",
      "/crawl/stream/job/task-1",
    ]
    reads.forEach((path) => {
      const policy = resolveBillingPricingPolicy("GET", path)
      assert.equal(policy.credits, 0, `${path} must not be charged`)
    })
  })

  it("publishes one rate per action, so no price is listed twice", () => {
    // `getPublicPricingRates` maps rules 1:1 with no dedupe, so two rows sharing an
    // action would render the same line twice on the pricing page. That is why the
    // crawl entry points share a single row instead of getting one each. Method is
    // part of the key, because the same action may legitimately be priced for both
    // a read and a write.
    const keys = getPublicPricingRates().map(
      (rate) => `${rate.method} ${rate.action}`,
    )

    assert.equal(
      new Set(keys).size,
      keys.length,
      `a rate is published more than once: ${keys.join(", ")}`,
    )
  })

  it("states the fallback as the fallback, and not as a listed action", () => {
    // `api.paid.default` is the price of anything unlisted. Publishing it in the
    // list would present it as something a customer can choose.
    const unlisted = resolveBillingPricingPolicy("POST", "/not-a-real-route")
    const fallback = getDefaultPricingRate()

    assert.equal(fallback.action, unlisted.action)
    assert.equal(fallback.credits, unlisted.credits)
    // No method: the fallback applies to every method, so naming one would be a
    // claim that is not true of DELETE.
    assert.equal("method" in fallback, false)
  })

  it("keeps every published rate usable as a price", () => {
    getPublicPricingRates().forEach((rate) => {
      assert.ok(rate.action.length > 0, "an action label may not be empty")
      assert.ok(Number.isInteger(rate.credits), "credits must be an integer")
      assert.ok(rate.credits >= 0, "credits may not be negative")
    })
  })

  it("prices a route the same whether or not the path carries /api", () => {
    // THE regression this normalization exists for. The BFF's bridge hands the
    // resolver the FULL pathname (`/api/crawl`); the table is keyed on the mount
    // relative one (`/crawl`). Before the normalization they resolved to different
    // policies and every priced BFF route silently charged the 1-credit fallback
    // while the rates page advertised its table price.
    const routes: Array<[string, string, string]> = [
      ["POST", "/crawl", "/api/crawl"],
      ["POST", "/machines/deploy", "/api/machines/deploy"],
      ["DELETE", "/machines/machine/abc", "/api/machines/machine/abc"],
      ["PUT", "/machines/machine/abc/start", "/api/machines/machine/abc/start"],
    ]

    routes.forEach(([method, mounted, full]) => {
      const fromMounted = resolveBillingPricingPolicy(method, mounted)
      const fromFull = resolveBillingPricingPolicy(method, full)

      assert.equal(fromFull.action, fromMounted.action)
      assert.equal(fromFull.credits, fromMounted.credits)
      // Not merely "equal to each other": both must be the LISTED action, or the
      // test would pass while both fell through to the fallback.
      assert.notEqual(fromFull.action, getDefaultPricingRate().action)
    })
  })

  it("does not treat every path as /api-relative", () => {
    // The lookahead is `(?=\/|$)`, so a segment that merely STARTS with `api` is
    // left alone rather than being chopped into a different route.
    const policy = resolveBillingPricingPolicy("POST", "/apiculture")
    assert.equal(policy.action, getDefaultPricingRate().action)
  })

  it("estimates the charged amount for a paying caller", () => {
    const estimate = estimateBillingCost("POST", "/api/crawl", "plan")

    assert.equal(estimate.chargeable, true)
    assert.equal(estimate.effectiveCredits, estimate.credits)
    assert.equal(estimate.credits, resolveBillingPricingPolicy("POST", "/crawl").credits)
    assert.equal(estimate.method, "POST")
  })

  it("estimates zero for a free caller and an admin", () => {
    // A free tier is charged nothing even for a listed action, so the estimate has
    // to reflect the CALLER and not just the table.
    const free = estimateBillingCost("POST", "/api/crawl", "free")
    assert.equal(free.chargeable, false)
    assert.equal(free.effectiveCredits, 0)
    // The table price is still reported: it is what the call WOULD cost.
    assert.ok(free.credits > 0)

    const admin = estimateBillingCost("POST", "/api/crawl", "admin")
    assert.equal(admin.chargeable, false)
    assert.equal(admin.effectiveCredits, 0)

    // Undefined entitlement fails closed, matching `resolveAccess`.
    const anonymous = estimateBillingCost("POST", "/api/crawl", undefined)
    assert.equal(anonymous.chargeable, false)
    assert.equal(anonymous.accessMode, "free")
  })
})
