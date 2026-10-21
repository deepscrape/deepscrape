/* eslint-disable max-len */
/**
 * Enterprise is sales-led, unlimited, and has no self-serve metered price.
 *
 * Three separate facts that have to hold together, which is why they are pinned in one
 * place:
 *
 * 1. **Catalog shape** -- no `payAsYouGo` entry. The old one was a zero-amount placeholder
 *    kept only to satisfy `Record<BillingInterval, ...>`, and the client rendered it as a
 *    EUR0.00 Enterprise option a customer could select (D5).
 * 2. **Flags** -- `salesLed` is what makes the purchase a conversation, `unlimited` is what
 *    the entitlement is provisioned as. Both live on the catalog so the UI and the server
 *    read one answer instead of three conditions.
 * 3. **Enforcement** -- `unlimited` must resolve to an access mode the pricing table
 *    refuses to charge, AND it must not survive a lapsed plan. The second half is the one
 *    worth guarding: a flag that outranks validity is free product for anyone who ever got
 *    the flag set.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {billingPlanCatalog} from "./stripe"
import {getBillingAccessMode, isChargeableAccessMode} from "../domain/billing.domain"

const planById = (id: string) => billingPlanCatalog.find((plan) => plan.id === id)

const PAST = "2020-01-01T00:00:00.000Z"
const FUTURE = "2099-01-01T00:00:00.000Z"
const NOW = Date.parse("2026-10-20T00:00:00.000Z")

describe("Enterprise tier shape", () => {
  it("sells no pay-as-you-go option at all", () => {
    // Not "a zero price": no entry. A zero is still a row the UI can render.
    assert.equal(planById("enterprise")?.prices.payAsYouGo, undefined)
  })

  it("is sales-led and unlimited", () => {
    const enterprise = planById("enterprise")

    assert.equal(enterprise?.salesLed, true)
    assert.equal(enterprise?.unlimited, true)
  })

  it("keeps its recurring intervals as a real anchor, all priced above zero", () => {
    // The term prices stay listed so a sales conversation starts from a number. Removing
    // them would leave "Contact sales" with nothing behind it.
    const prices = planById("enterprise")?.prices

    for (const interval of ["monthly", "quarterly", "annually"] as const) {
      assert.ok((prices?.[interval]?.amount ?? 0) > 0, `${interval} must be priced`)
    }
  })

  it("leaves no paid tier advertising a zero-amount price", () => {
    // The general form of D5: free and trial are legitimately zero, every other tier that
    // lists an interval must have a price behind it.
    for (const plan of billingPlanCatalog) {
      if (plan.id === "free" || plan.id === "trial") {
        continue
      }

      for (const [interval, price] of Object.entries(plan.prices)) {
        assert.ok((price?.amount ?? 0) > 0, `${plan.id}:${interval} advertises ${price?.amount}`)
      }
    }
  })

  it("leaves the self-serve tiers untouched", () => {
    // The change is scoped to Enterprise; a regression here would silently remove a tier
    // customers are buying today.
    for (const id of ["starter", "pro"]) {
      const plan = planById(id)

      assert.equal(plan?.salesLed, undefined)
      assert.ok((plan?.prices.payAsYouGo?.amount ?? 0) > 0, `${id} keeps pay-as-you-go`)
      assert.ok((plan?.prices.monthly?.amount ?? 0) > 0, `${id} keeps monthly`)
    }
  })
})

describe("unlimited access mode", () => {
  it("resolves to its own mode rather than plan", () => {
    assert.equal(getBillingAccessMode({plan: "enterprise", unlimited: true}, NOW), "unlimited")
  })

  it("is never charged, which is what actually makes usage unmetered", () => {
    // Every charging path asks this predicate. If it ever returned true for `unlimited`,
    // a wallet would be drawn down that the agreement says should not be.
    assert.equal(isChargeableAccessMode("unlimited"), false)
    assert.equal(isChargeableAccessMode("plan"), true)
    assert.equal(isChargeableAccessMode("credits"), true)
  })

  it("grants nothing once the plan itself has lapsed", () => {
    // A closed pay-as-you-go window with no credits left is `free` even with the flag set.
    // The flag REFINES the validity verdict; it does not replace it.
    const lapsed = {
      plan: "enterprise",
      planInterval: "payAsYouGo",
      currentPeriodEnd: PAST,
      unlimited: true,
    }

    assert.equal(getBillingAccessMode(lapsed, NOW), "free")
  })

  it("still grants access while the plan is valid", () => {
    const live = {
      plan: "enterprise",
      planInterval: "payAsYouGo",
      currentPeriodEnd: FUTURE,
      unlimited: true,
    }

    assert.equal(getBillingAccessMode(live, NOW), "unlimited")
  })

  it("leaves an ordinary subscription on plan", () => {
    assert.equal(getBillingAccessMode({plan: "pro"}, NOW), "plan")
    assert.equal(getBillingAccessMode({plan: "enterprise", unlimited: false}, NOW), "plan")
  })

  it("honours an end date, so a pilot cannot run free forever", () => {
    const pilot = {plan: "enterprise", unlimited: true, unlimitedUntil: FUTURE}

    assert.equal(getBillingAccessMode(pilot, NOW), "unlimited")
    assert.equal(getBillingAccessMode(pilot, Date.parse(FUTURE) + 1), "plan")
  })

  it("treats an unreadable end date as closed", () => {
    // Same direction as `isPaygWindowClosed`: a date nobody can read is not one to keep
    // honouring. Failing open here would make a typo the most valuable field in the system.
    const typo = {plan: "enterprise", unlimited: true, unlimitedUntil: "next tuesday"}

    assert.equal(getBillingAccessMode(typo, NOW), "plan")
  })
})
