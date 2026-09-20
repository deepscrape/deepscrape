/* eslint-disable max-len */
/**
 * The client-event allow-list is a contract with three failure modes that are all
 * silent in production, which is why they are asserted here.
 *
 * 1. A name emitted but not listed is stored as a fact and counted under `unknown`,
 *    so it is invisible in the panels that read known counter keys.
 * 2. A name listed but never emitted is dead weight that makes the list look more
 *    complete than the instrumentation is (it is not asserted — the emitter lives in
 *    the Angular bundle, which this test cannot see).
 * 3. A name that is not lowercase snake_case splits one logical event across two
 *    counter keys as soon as anyone writes it the other way.
 *
 * `normalizeUtm` is here for the same reason: it is the canonicaliser behind every
 * `byChannel.<source>` counter, and until this test existed the logic lived as an
 * inline closure inside the guest-tracker request handler, where no test could reach it.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  CLIENT_ANALYTICS_EVENTS,
  UNKNOWN_CLIENT_ANALYTICS_EVENT,
  isClientAnalyticsEvent,
  normalizeClientAnalyticsEvent,
} from "../../../src/config/analytics-events"
import {normalizeUtm} from "./analytics-helpers"

/**
 * client analytics event contract
 */
describe("client analytics event contract", () => {
  it("accepts every listed event verbatim", () => {
    for (const name of CLIENT_ANALYTICS_EVENTS) {
      assert.equal(isClientAnalyticsEvent(name), true, `${name} should be on the allow-list`)
      assert.equal(normalizeClientAnalyticsEvent(name), name)
    }
  })

  it("collapses anything off-list into one bounded bucket", () => {
    // A typo, a name that was removed, and the right name in the wrong case: all three
    // used to mint their own counter key in metrics_daily/metrics_hourly.
    assert.equal(normalizeClientAnalyticsEvent("crawl_strted"), UNKNOWN_CLIENT_ANALYTICS_EVENT)
    assert.equal(normalizeClientAnalyticsEvent("cta_hero_clicked"), UNKNOWN_CLIENT_ANALYTICS_EVENT)
    assert.equal(normalizeClientAnalyticsEvent("PAGE_VIEW"), UNKNOWN_CLIENT_ANALYTICS_EVENT)
  })

  it("treats absent or non-string input as unknown rather than throwing", () => {
    for (const value of [undefined, null, 42, true, {}, [], ["page_view"]]) {
      assert.equal(
        normalizeClientAnalyticsEvent(value),
        UNKNOWN_CLIENT_ANALYTICS_EVENT,
        `${JSON.stringify(value)} should normalise to unknown`,
      )
      assert.equal(isClientAnalyticsEvent(value), false)
    }
  })

  it("keeps names lowercase snake_case and unique", () => {
    const seen = new Set<string>()

    for (const name of CLIENT_ANALYTICS_EVENTS) {
      assert.match(name, /^[a-z][a-z0-9_]*$/, `${name} is not lowercase snake_case`)
      assert.equal(seen.has(name), false, `${name} is listed twice`)
      seen.add(name)
    }
  })
})

/**
 * utm canonicalisation
 */
describe("utm canonicalisation", () => {
  it("collapses case and separator variants onto one value", () => {
    for (const raw of ["Google", "google ", "GOOGLE", "google+ads", "google  ads"]) {
      assert.equal(normalizeUtm(raw), raw.trim().toLowerCase().replace(/[\s+]+/g, "_"))
    }

    assert.equal(normalizeUtm("Spring Sale"), "spring_sale")
    assert.equal(normalizeUtm("spring+sale"), "spring_sale")
  })

  it("returns undefined for empty input so no empty channel key is written", () => {
    for (const raw of ["", "   ", "+", undefined, null, 7, {}]) {
      assert.equal(normalizeUtm(raw), undefined)
    }
  })

  it("bounds the length so a hostile query string cannot bloat counter keys", () => {
    const long = normalizeUtm("x".repeat(500))
    assert.equal(long?.length, 60)
  })
})
