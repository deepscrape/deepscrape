/* eslint-disable max-len */
/**
 * An invoice's subscription moved between Stripe API versions: it was `invoice.subscription`
 * in the 2023 versions and became `invoice.parent.subscription_details.subscription` in the
 * 2025 ones. The live webhook endpoint pins NO api_version, so it follows the account default
 * and can silently change shape, while the test endpoint is pinned to 2023-10-16. Reading one
 * location meant the same code parsed differently in the two environments.
 *
 * `invoice.upcoming` is the branch that made this dangerous: it `break`s when the id is
 * missing, so renewal-warning alerts would disappear from live while still firing in test —
 * no error, no log, nothing to notice.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import type Stripe from "stripe"
import {getInvoiceSubscriptionId} from "./stripe"

const invoiceWith = (fields: Record<string, unknown>): Stripe.Invoice =>
  fields as unknown as Stripe.Invoice

/**
 * subscription id across API versions
 */
describe("getInvoiceSubscriptionId", () => {
  it("reads the 2023 shape, where the id is a plain string", () => {
    assert.equal(
      getInvoiceSubscriptionId(invoiceWith({subscription: "sub_legacy"})),
      "sub_legacy",
    )
  })

  it("reads the 2023 shape when the subscription was expanded to an object", () => {
    assert.equal(
      getInvoiceSubscriptionId(invoiceWith({subscription: {id: "sub_expanded"}})),
      "sub_expanded",
    )
  })

  it("reads the 2025 shape when the legacy field is absent", () => {
    assert.equal(
      getInvoiceSubscriptionId(invoiceWith({
        parent: {subscription_details: {subscription: "sub_nested"}},
      })),
      "sub_nested",
    )
  })

  it("reads the 2025 shape when the nested subscription was expanded", () => {
    assert.equal(
      getInvoiceSubscriptionId(invoiceWith({
        parent: {subscription_details: {subscription: {id: "sub_nested_expanded"}}},
      })),
      "sub_nested_expanded",
    )
  })

  it("prefers the legacy field when a version sends both", () => {
    assert.equal(
      getInvoiceSubscriptionId(invoiceWith({
        subscription: "sub_legacy",
        parent: {subscription_details: {subscription: "sub_nested"}},
      })),
      "sub_legacy",
    )
  })

  it("returns null when neither version carries a subscription, so no id is invented", () => {
    // A one-off invoice has no subscription in either shape. Returning a placeholder here
    // would make `invoice.upcoming` emit an alert keyed on nothing.
    assert.equal(getInvoiceSubscriptionId(invoiceWith({})), null)
    assert.equal(
      getInvoiceSubscriptionId(invoiceWith({parent: {subscription_details: {}}})),
      null,
    )
  })
})
