/* eslint-disable max-len */
/**
 * Who a Stripe event is billed to.
 *
 * The whole org-subscription feature rests on one key in `metadata`, so the two readers of
 * that key are pinned here: getting the org wrong does not throw, it writes a workspace's
 * plan into a member's personal wallet (or the reverse) and nothing ever notices.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import type Stripe from "stripe"
import {invoiceSubjectOrgId, stripeSubjectOrgId} from "./stripe"

describe("stripe billing subject", () => {
  it("reads the organization off metadata", () => {
    assert.equal(stripeSubjectOrgId({metadata: {orgId: "org_a"}}), "org_a")
    assert.equal(stripeSubjectOrgId({metadata: {orgId: "  org_a  "}}), "org_a")
  })

  it("treats a blank or absent org as a personal purchase", () => {
    assert.equal(stripeSubjectOrgId({metadata: {orgId: ""}}), undefined)
    assert.equal(stripeSubjectOrgId({metadata: {}}), undefined)
    assert.equal(stripeSubjectOrgId({}), undefined)
    assert.equal(stripeSubjectOrgId(null), undefined)
    assert.equal(stripeSubjectOrgId(undefined), undefined)
  })

  it("finds the org on a subscription invoice, where the invoice itself carries none", () => {
    // Stripe puts the subscription's metadata on `parent.subscription_details`; the invoice's
    // own metadata is empty, which is exactly how an org renewal would be misattributed to
    // the member who happened to buy the plan.
    const invoice = {
      metadata: {},
      parent: {subscription_details: {metadata: {orgId: "org_b", uid: "u1"}}},
    } as unknown as Stripe.Invoice

    assert.equal(invoiceSubjectOrgId(invoice), "org_b")
  })

  it("prefers the invoice's own metadata, and answers undefined for a personal invoice", () => {
    const tagged = {metadata: {orgId: "org_c"}, parent: null} as unknown as Stripe.Invoice
    assert.equal(invoiceSubjectOrgId(tagged), "org_c")

    const personal = {metadata: {uid: "u1"}} as unknown as Stripe.Invoice
    assert.equal(invoiceSubjectOrgId(personal), undefined)
  })
})
