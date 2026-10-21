/* eslint-disable max-len */
/**
 * The billing period moved off the subscription and onto its items.
 *
 * Stripe 2025-03-31 ("basil") removed `subscription.current_period_start` and
 * `subscription.current_period_end`, replacing them with per-item periods. The
 * installed typings (stripe@17, 2024 acacia) still declare the subscription-level
 * fields, so TypeScript could not catch the five call sites that read them.
 *
 * The consequence was worse than an empty date. Every trialing branch built
 * `new Date(current_period_start * 1000).toISOString()`, and `new Date(undefined)`
 * is an Invalid Date whose `toISOString()` throws a RangeError -- so the webhook
 * handler for a trialing subscription would have failed outright rather than
 * writing a null. These specs pin the item-first read AND the never-throw behaviour,
 * because the throw is the part that would take a webhook down at 3am.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {getSubscriptionPeriod} from "./stripe"

const isoOf = (seconds: number): string => new Date(seconds * 1000).toISOString()

describe("getSubscriptionPeriod", () => {
  it("prefers the item's period, which is where the 2025 API versions put it", () => {
    const period = getSubscriptionPeriod({
      items: {data: [{current_period_start: 1_700_000_000, current_period_end: 1_702_592_000}]},
    })

    assert.equal(period.start, 1_700_000_000)
    assert.equal(period.end, 1_702_592_000)
  })

  it("reads the subscription-level periods when the item has none", () => {
    // Events queued before the endpoint's version moved still carry these.
    const period = getSubscriptionPeriod({
      current_period_start: 1_690_000_000,
      current_period_end: 1_692_592_000,
      items: {data: [{}]},
    })

    assert.equal(period.start, 1_690_000_000)
    assert.equal(period.end, 1_692_592_000)
  })

  it("never lets an item's null shadow a subscription-level value", () => {
    // An expanded item can carry `current_period_start: null` while the older
    // subscription field is populated. `??` treats both null and undefined as
    // absent, which is exactly the behaviour wanted here.
    const period = getSubscriptionPeriod({
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_592_000,
      items: {data: [{current_period_start: null, current_period_end: null}]},
    })

    assert.equal(period.start, 1_700_000_000)
    assert.equal(period.end, 1_702_592_000)
  })

  it("falls back to billing_cycle_anchor for the start, which the object always has", () => {
    const period = getSubscriptionPeriod({billing_cycle_anchor: 1_705_000_000})

    assert.equal(period.start, 1_705_000_000)
    assert.equal(period.end, null)
  })

  it("returns nulls rather than NaN for a subscription with no periods at all", () => {
    // This is the 2025-shaped trialing subscription: no item period, no
    // subscription period. Callers must get null so `toIsoOrNull` short-circuits
    // instead of formatting an Invalid Date.
    assert.deepEqual(getSubscriptionPeriod({items: {data: []}}), {start: null, end: null})
    assert.deepEqual(getSubscriptionPeriod({}), {start: null, end: null})
  })

  it("treats a non-numeric period as absent", () => {
    const period = getSubscriptionPeriod({
      current_period_start: "1700000000",
      current_period_end: Number.NaN,
      items: {data: [{current_period_start: Number.POSITIVE_INFINITY}]},
    })

    assert.equal(period.start, null)
    assert.equal(period.end, null)
  })

  it("survives a null subscription instead of throwing on the way in", () => {
    // `stripe.subscriptions.retrieve` cannot return null, but the four trial
    // branches run inside webhook handlers where a malformed event is a live
    // possibility, and a throw there loses the whole delivery.
    assert.deepEqual(getSubscriptionPeriod(null), {start: null, end: null})
    assert.deepEqual(getSubscriptionPeriod(undefined), {start: null, end: null})
  })

  it("converts a real period to the ISO strings the billing document stores", () => {
    const {start, end} = getSubscriptionPeriod({
      items: {data: [{current_period_start: 1_700_000_000, current_period_end: 1_702_592_000}]},
    })

    assert.equal(start === null ? null : isoOf(start), "2023-11-14T22:13:20.000Z")
    assert.equal(end === null ? null : isoOf(end), "2023-12-14T22:13:20.000Z")
  })
})
