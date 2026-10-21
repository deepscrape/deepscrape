/* eslint-disable max-len */
/**
 * A credit grant must produce a STABLE ledger key, or a retry mints again.
 *
 * `applyBillingCreditMutation` derives the ledger document id from
 * `idempotencyKey` and returns unchanged when that document exists — so the key is
 * the entire idempotency story. A grant with no Stripe object behind it used to
 * produce `null`, which meant a random document id: an admin double-click, or a
 * client retry, credited the account twice and nothing could detect it.
 *
 * Which is why the `requestId` case is the point of this file rather than an
 * afterthought, and why the null case is pinned too: null is only correct when
 * NOTHING identifies the grant.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {creditsIdempotencyKey} from "./stripe"

const base = {bucket: "purchased", source: "promotional_credit"}

describe("credit grant idempotency key", () => {
  it("collapses a promotional grant on the caller's request id", () => {
    const first = creditsIdempotencyKey({...base, requestId: "abc-123"})
    const retry = creditsIdempotencyKey({...base, requestId: "abc-123"})

    assert.equal(first, "request:abc-123:purchased")
    assert.equal(retry, first)
  })

  it("keeps two different grants apart", () => {
    assert.notEqual(
      creditsIdempotencyKey({...base, requestId: "abc-123"}),
      creditsIdempotencyKey({...base, requestId: "abc-124"}),
    )
  })

  it("prefers the most specific Stripe object over the request id", () => {
    assert.equal(
      creditsIdempotencyKey({...base, reason: "pack", invoiceId: "in_1", requestId: "abc-123"}),
      "invoice:in_1:purchased:pack",
    )
    assert.equal(
      creditsIdempotencyKey({...base, reason: "pack", paymentIntentId: "pi_1", requestId: "abc-123"}),
      "payment_intent:pi_1:purchased:pack",
    )
    assert.equal(
      creditsIdempotencyKey({...base, reason: "meter", sessionId: "s_1", requestId: "abc-123"}),
      "session:s_1:purchased:meter",
    )
  })

  it("falls back to the source when no reason is given", () => {
    assert.equal(
      creditsIdempotencyKey({bucket: "included", source: "plan_renewal", invoiceId: "in_2"}),
      "invoice:in_2:included:plan_renewal",
    )
  })

  it("returns null only when nothing identifies the grant", () => {
    assert.equal(creditsIdempotencyKey(base), null)
  })
})
