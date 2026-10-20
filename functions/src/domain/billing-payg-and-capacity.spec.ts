/* eslint-disable object-curly-spacing */
/**
 * The two pricing decisions taken on 2026-10-20, pinned.
 *
 * Part 1 — the `payAsYouGo` window. A one-off payment used to grant the tier
 * for good: the writer stored `currentPeriodEnd: null` and nothing checked
 * a date, so EUR1.99 bought Pro permanently and could be bought again. The
 * window is 10% of a month, the same fraction as the price (EUR1.99 against
 * EUR19.99) and as the credit grant (10% of the monthly allowance).
 *
 * Part 2 — the capacity tools' prices. They had no rule in the table, so they
 * were priced by the fallback at 1 credit: a site-wide spider cost a third of a
 * single crawl request. The assertions below are the numbers, so a later edit
 * that re-breaks them fails here rather than in a customer's invoice.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"

import {
  PAYG_ACCESS_DAYS,
  getBillingAccessMode,
  isPaygWindowClosed,
  paygAccessEndsAt,
} from "./billing.domain"
import {resolveBillingPricingPolicy} from "./billing-pricing.domain"

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

describe("payAsYouGo access window", () => {
  it("is 10% of a 30-day month, like the price and credits", () => {
    // Ten of these for 30 days must cost about one monthly price, or PAYG
    // undercuts the subscription it is a tenth of.
    assert.equal(PAYG_ACCESS_DAYS, 3)
  })

  it("closes a payg plan once the window has passed", () => {
    const billing = {
      plan: "pro",
      planInterval: "payAsYouGo",
      currentPeriodEnd: paygAccessEndsAt(NOW),
    }

    assert.equal(isPaygWindowClosed(billing, NOW + DAY), false)
    assert.equal(isPaygWindowClosed(billing, NOW + 3 * DAY), true)
    assert.equal(isPaygWindowClosed(billing, NOW + 4 * DAY), true)
  })

  it("treats a payg row with no end date as CLOSED", () => {
    // This is the row the pre-fix writer produced. Reading it as still valid
    // would preserve the defect for exactly the records it created.
    const legacy = {
      plan: "pro",
      planInterval: "payAsYouGo",
      currentPeriodEnd: null,
    }

    assert.equal(isPaygWindowClosed(legacy, NOW), true)
    assert.equal(
      isPaygWindowClosed({plan: "pro", planInterval: "payAsYouGo"}, NOW),
      true,
    )
  })

  it("treats an unparseable end date as CLOSED, not as forever", () => {
    assert.equal(
      isPaygWindowClosed(
        {
          plan: "pro",
          planInterval: "payAsYouGo",
          currentPeriodEnd: "not a date",
        },
        NOW,
      ),
      true,
    )
  })

  it("never touches a subscription, which Stripe lapses by status", () => {
    const intervals = ["monthly", "quarterly", "annually", undefined]

    for (const planInterval of intervals) {
      assert.equal(
        isPaygWindowClosed(
          {plan: "pro", planInterval, currentPeriodEnd: null},
          NOW,
        ),
        false,
        String(planInterval),
      )
    }
  })

  it("stops granting plan access once the window closes", () => {
    const expired = {
      plan: "pro",
      planInterval: "payAsYouGo",
      currentPeriodEnd: paygAccessEndsAt(NOW),
    }

    assert.equal(getBillingAccessMode(expired, NOW + DAY), "plan")
    assert.equal(getBillingAccessMode(expired, NOW + 3 * DAY), "free")
  })

  it("still spends purchased credits after the window closes", () => {
    // Credits outlive the plan they were bought beside. Keying the credits
    // branch on `plan === "free"` stranded them, because the stored plan still
    // reads "pro" after a payg window shuts.
    const expiredWithCredits = {
      plan: "pro",
      planInterval: "payAsYouGo",
      currentPeriodEnd: paygAccessEndsAt(NOW),
      credits: {purchasedBalance: 50, purchasedReserved: 0},
    }

    assert.equal(
      getBillingAccessMode(expiredWithCredits, NOW + 10 * DAY),
      "credits",
    )
  })
})

describe("capacity tool prices", () => {
  /**
   * Every route below carries the `paid` guard in `bff/api.ts`, so each one was
   * charged by whatever the table said. Before this, the answer for all of them
   * was the fallback.
   * @param {*} path
   * @return {*}
   */
  const price = (path: string) => resolveBillingPricingPolicy("POST", path)

  it("prices a site walk above a single crawl request", () => {
    const crawl = resolveBillingPricingPolicy("POST", "/crawl").credits
    const spider = price("/spider").credits

    assert.equal(spider, 10)
    assert.ok(spider > crawl, "a spider must not be cheaper than one crawl")
  })

  it("prices an unbounded payload above a browser step", () => {
    assert.equal(price("/download").credits, 5)
    assert.equal(price("/watch").credits, 5)
    assert.ok(price("/download").credits > price("/navigate").credits)
  })

  it("prices batch at the crawl rate, for N urls in one call", () => {
    assert.equal(price("/batch").credits, 3)
  })

  it("prices the browser steps and image work", () => {
    assert.equal(price("/navigate").credits, 1)
    assert.equal(price("/observe").credits, 1)
    assert.equal(price("/vision").credits, 2)
  })

  it("leaves no paid capacity route on the fallback", () => {
    // The whole point. A route that resolves to `api.paid.default` is one
    // nobody priced, and the failure is silent because 1 credit looks cheap.
    for (const path of [
      "/navigate",
      "/observe",
      "/vision",
      "/batch",
      "/spider",
      "/download",
      "/watch",
    ]) {
      assert.notEqual(price(path).action, "api.paid.default", path)
    }
  })

  it("makes listing your own machines free", () => {
    // One Firestore read, no browser, and the panel lists on every open.
    const listed = resolveBillingPricingPolicy("GET", "/machines")

    assert.equal(listed.action, "machines.list")
    assert.equal(listed.credits, 0)
  })
})
