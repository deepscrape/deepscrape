/* eslint-disable max-len */
/**
 * The mapping from a Stripe price to a plan tier is the step production got silently wrong.
 * The catalog carried hardcoded test-mode price ids, the live account contained none of them,
 * so `inferRecurringPlanFromPriceId` matched nothing, the webhook returned early, and
 * customers paid for subscriptions that were never activated. Reverting the lookup_key-first
 * match restores that bug and nothing else in the suite notices.
 *
 * `stripe.ts` is imported for real: this is the code that runs, and a copy of the mapping
 * living in a spec would pass while production failed - which is the whole point.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import type Stripe from "stripe"
import {billingPlanCatalog, getInvoiceRecurringPrice, inferRecurringPlanFromPriceId} from "./stripe"

// Read the id the catalog actually holds, so this cannot drift from the config.
const catalogPriceId = (plan: string, interval: "monthly" | "quarterly" | "annually"): string | undefined =>
  billingPlanCatalog.find((entry) => entry.id === plan)?.prices[interval]?.stripePriceId

const invoiceWith = (line: unknown): Stripe.Invoice => ({lines: {data: [line]}}) as unknown as Stripe.Invoice

/**
 * plan inference from a price
 */
describe("inferRecurringPlanFromPriceId", () => {
  it("resolves a plan from the lookup_key alone, with an id it has never seen", () => {
    // The live account returns live-mode ids that appear nowhere in this repo.
    assert.deepEqual(
      inferRecurringPlanFromPriceId("price_LIVEMODEONLY", "ds_pro_monthly"),
      {plan: "pro", interval: "monthly"},
    )
    assert.deepEqual(
      inferRecurringPlanFromPriceId("price_LIVEMODEONLY", "ds_enterprise_annual"),
      {plan: "enterprise", interval: "annually"},
    )
  })

  it("still resolves from a catalog price id when the account has no lookup keys", () => {
    assert.deepEqual(
      inferRecurringPlanFromPriceId(catalogPriceId("pro", "monthly")),
      {plan: "pro", interval: "monthly"},
    )
    assert.deepEqual(
      inferRecurringPlanFromPriceId(catalogPriceId("starter", "quarterly")),
      {plan: "starter", interval: "quarterly"},
    )
  })

  it("never infers a plan from a one-time price", () => {
    // Pay-as-you-go and credit packs are one-time prices; treating one as a subscription
    // would grant a recurring plan for a single payment.
    assert.equal(inferRecurringPlanFromPriceId("price_x", "ds_pro_payg"), null)
    assert.equal(inferRecurringPlanFromPriceId("price_x", "ds_credits_500"), null)
  })

  it("returns null instead of throwing when there is nothing to match on", () => {
    assert.equal(inferRecurringPlanFromPriceId(null, null), null)
    assert.equal(inferRecurringPlanFromPriceId(undefined), null)
  })
})

/**
 * the price on an invoice
 */
describe("getInvoiceRecurringPrice", () => {
  it("reads the legacy line price and carries its lookup_key", () => {
    const ref = getInvoiceRecurringPrice(invoiceWith({price: {id: "price_a", lookup_key: "ds_pro_monthly"}}))

    assert.deepEqual(ref, {id: "price_a", lookupKey: "ds_pro_monthly"})
  })

  it("reads the modern pricing.price_details shape, where the key lives on the nested price", () => {
    const ref = getInvoiceRecurringPrice(invoiceWith({
      pricing: {price_details: {price: {id: "price_b", lookup_key: "ds_starter_annual"}}},
    }))

    assert.deepEqual(ref, {id: "price_b", lookupKey: "ds_starter_annual"})
  })

  it("accepts a bare price id and reports no lookup_key for it", () => {
    const ref = getInvoiceRecurringPrice(invoiceWith({pricing: {price_details: {price: "price_c"}}}))

    assert.deepEqual(ref, {id: "price_c", lookupKey: null})
  })

  it("returns null for an invoice with no priced line", () => {
    assert.equal(getInvoiceRecurringPrice({lines: {data: []}} as unknown as Stripe.Invoice), null)
  })

  it("takes the first priced line", () => {
    // ponytail: first line wins, which is safe only while a subscription invoice carries
    // nothing but subscription lines. Add a one-time add-on to the same invoice and the
    // first line becomes the add-on, plan inference fails and the plan is never activated.
    const invoice = {lines: {data: [
      {price: {id: "price_addon", lookup_key: null}},
      {price: {id: "price_plan", lookup_key: "ds_pro_monthly"}},
    ]}} as unknown as Stripe.Invoice

    assert.deepEqual(getInvoiceRecurringPrice(invoice), {id: "price_addon", lookupKey: null})
  })
})
