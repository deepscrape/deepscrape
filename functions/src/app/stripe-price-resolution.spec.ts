/* eslint-disable max-len */
/**
 * The lookup keys are the only thing binding this code to a Stripe account. Nobody
 * generates them: a human types them into Stripe, and this module has to agree. A rename
 * on either side fails at checkout with "No such price", which is exactly the class of
 * bug the resolver was written to remove, so the convention is asserted instead of
 * assumed.
 *
 * The resolver's fallback is asserted too, because it is the property that makes the
 * change safe to deploy: a Stripe failure must return the catalog id, never throw.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {findUnusableCatalogPrices, lookupKeyForCredits, lookupKeyForPlan, resolvePriceId} from "./stripe-price-resolution"

/**
 * stripe price lookup keys
 */
describe("stripe price lookup keys", () => {
  it("derives the keys that are live on the account", () => {
    // The shortened interval names are the part that would silently break: the catalog
    // calls them payAsYouGo/annually, the keys are payg/annual.
    assert.equal(lookupKeyForPlan("starter", "monthly"), "ds_starter_monthly")
    assert.equal(lookupKeyForPlan("starter", "payAsYouGo"), "ds_starter_payg")
    assert.equal(lookupKeyForPlan("starter", "annually"), "ds_starter_annual")
    assert.equal(lookupKeyForPlan("pro", "quarterly"), "ds_pro_quarterly")
    assert.equal(lookupKeyForPlan("enterprise", "annually"), "ds_enterprise_annual")
    assert.equal(lookupKeyForCredits(100), "ds_credits_100")
    assert.equal(lookupKeyForCredits(2000), "ds_credits_2000")
  })
})

/**
 * stripe price resolution
 */
describe("stripe price resolution", () => {
  it("resolves a key once, then serves the hit from cache", async () => {
    let listCalls = 0
    const stripe = {
      prices: {
        list: async () => {
          listCalls += 1
          return {data: [{id: "price_live_1"}]}
        },
      },
    }

    assert.equal(await resolvePriceId(stripe, "ds_pro_monthly", "price_test_1"), "price_live_1")
    assert.equal(await resolvePriceId(stripe, "ds_pro_monthly", "price_test_1"), "price_live_1")
    assert.equal(listCalls, 1, "second resolution should come from the cache")
  })

  it("falls back to the catalog id when the key is not in the account", async () => {
    const stripe = {prices: {list: async () => ({data: []})}}

    assert.equal(await resolvePriceId(stripe, "ds_team_monthly", "price_test_2"), "price_test_2")
  })

  it("falls back instead of throwing when Stripe is unreachable", async () => {
    const stripe = {
      prices: {
        list: async () => {
          throw new Error("stripe down")
        },
      },
    }

    assert.equal(await resolvePriceId(stripe, "ds_starter_annual", "price_test_3"), "price_test_3")
  })

  it("returns undefined rather than an empty string when there is nothing to fall back to", async () => {
    const stripe = {prices: {list: async () => ({data: []})}}

    assert.equal(await resolvePriceId(stripe, "ds_enterprise_payg"), undefined)
  })
})

/**
 * The hourly catalog check. Its whole value is not crying wolf: an account with the
 * lookup keys is fine, an account configured by env ids is ALSO fine, and only an id the
 * account cannot read is news. Get that wrong and the incident is noise nobody reads.
 */
describe("findUnusableCatalogPrices", () => {
  it("reports nothing when every key resolves in the account", async () => {
    const stripe = {
      prices: {
        list: async () => ({data: [{id: "price_live_1"}]}),
        retrieve: async () => ({id: "price_live_1"}),
      },
    }

    const unusable = await findUnusableCatalogPrices(stripe, [
      {key: "ds_a_monthly", fallbackId: "price_test_a"},
      {key: "ds_b_annual", fallbackId: "price_test_b"},
    ])

    assert.deepEqual(unusable, [])
  })

  it("blames the hardcoded id the fallback handed over when the account lacks it", async () => {
    const stripe = {
      prices: {
        list: async () => ({data: []}),
        retrieve: async () => {
          throw new Error("No such price: 'price_test_c'")
        },
      },
    }

    const unusable = await findUnusableCatalogPrices(stripe, [{key: "ds_c_monthly", fallbackId: "price_test_c"}])

    assert.equal(unusable.length, 1)
    assert.match(unusable[0], /ds_c_monthly/)
    assert.match(unusable[0], /price_test_c/)
  })

  it("accepts a deployment configured by env ids instead of lookup keys", async () => {
    // The key is absent but the configured id is real. Checkout works; say nothing.
    const stripe = {
      prices: {
        list: async () => ({data: []}),
        retrieve: async () => ({id: "price_env_d"}),
      },
    }

    assert.deepEqual(await findUnusableCatalogPrices(stripe, [{key: "ds_d_monthly", fallbackId: "price_env_d"}]), [])
  })

  it("reports a price with neither a key nor an id", async () => {
    const stripe = {prices: {list: async () => ({data: []}), retrieve: async () => ({id: "never"})}}

    const unusable = await findUnusableCatalogPrices(stripe, [{key: "ds_e_quarterly"}])

    assert.equal(unusable.length, 1)
    assert.match(unusable[0], /no fallback id/)
  })
})
