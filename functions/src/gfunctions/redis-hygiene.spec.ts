/* eslint-disable max-len */
/**
 * Tests for the Redis hygiene audit.
 *
 * The audit is driven through a fake client so it needs no live Redis, which is
 * why `AuditRedis` is a narrow structural type rather than `Redis` itself.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  ANALYTICS_EVENTS_KEY,
  CLIENT_EVENT_LIST_MAX,
  ONLINE_GUESTS_KEY,
  ONLINE_USERS_KEY,
} from "../../../src/config/redis-keys"
import {
  auditPrefix,
  auditRedisKeys,
  renderReport,
  type AuditRedis,
  type HygieneReport,
} from "../../scripts/redis-hygiene"

/** Builds a fake client from a key -> ttl map plus a backlog size.
 * @param {*} options
 * @return {*}
 */
const createFakeRedis = (options: {
  keys: Record<string, number>
  backlog?: number
  zcard?: number
}): AuditRedis => {
  const keys = Object.keys(options.keys)
  return {
    dbsize: async () => keys.length,
    llen: async () => options.backlog ?? 0,
    zcard: async () => options.zcard ?? 0,
    ttl: async (key: string) => {
      if (!(key in options.keys)) {
        return -2
      }
      return options.keys[key]
    },
    scan: async (_cursor, {match}) => {
      // Translate the glob into a prefix test. Only the trailing `*` form is used
      // by EXPECTED_PREFIXES, so string prefix matching is sufficient here.
      const prefix = match.endsWith("*") ? match.slice(0, -1) : match
      return [0, keys.filter((key) => key.startsWith(prefix))]
    },
  }
}

/**
 * redis hygiene audit
 */
describe("redis hygiene audit", () => {
  /**
   * flags a sampled key that has no expiry
   */
  it("flags a sampled key that has no expiry", async () => {
    const redis = createFakeRedis({
      keys: {
        "session:expiring": 1800,
        "guestfp:leaky": -1,
      },
    })

    const report = await auditPrefix(redis, "guestfp:*", 25)

    assert.equal(report.sampled, 1)
    assert.equal(report.withoutExpiry, 1)
    assert.deepEqual(report.worstOffenders, ["guestfp:leaky"])
    assert.equal(report.minTtlSeconds, null)
  })

  /**
   * reports the shortest TTL among samples
   */
  it("reports the shortest TTL among samples", async () => {
    const redis = createFakeRedis({
      keys: {
        "session:a": 1800,
        "session:b": 42,
        "session:c": 600,
      },
    })

    const report = await auditPrefix(redis, "session:*", 25)

    assert.equal(report.sampled, 3)
    assert.equal(report.withoutExpiry, 0)
    assert.equal(report.minTtlSeconds, 42)
  })

  /**
   * counts keys that vanish between SCAN and TTL as drained, not unbounded
   */
  it("counts keys that vanish between SCAN and TTL as drained, not unbounded", async () => {
    const base = createFakeRedis({keys: {"session:a": 60}})
    const redis: AuditRedis = {
      ...base,
      scan: async () => [0, ["session:a", "session:already-gone"]],
    }

    const report = await auditPrefix(redis, "session:*", 25)

    assert.equal(report.vanished, 1)
    assert.equal(report.withoutExpiry, 0)
  })

  /**
   * allows the analytics list to have no TTL because it is capped by LTRIM
   */
  it("allows the analytics list to have no TTL because it is capped by LTRIM", async () => {
    const redis = createFakeRedis({keys: {[ANALYTICS_EVENTS_KEY]: -1}})

    const report = await auditPrefix(redis, ANALYTICS_EVENTS_KEY, 25)

    assert.equal(report.withoutExpiry, 0)
  })

  /**
   * fails the run when the analytics backlog exceeds its ingress cap
   */
  it("fails the run when the analytics backlog exceeds its ingress cap", async () => {
    const redis = createFakeRedis({keys: {}, backlog: CLIENT_EVENT_LIST_MAX + 1})

    const report = await auditRedisKeys(redis, {prefixes: []})
    const {exitCode, text} = renderReport(report)

    assert.equal(report.analyticsBacklogOverLimit, true)
    assert.equal(exitCode, 1)
    assert.match(text, /OVER LIMIT/)
  })

  /**
   * passes when every sampled key is bounded and the backlog is within the cap
   */
  it("passes when every sampled key is bounded and the backlog is within the cap", async () => {
    const redis = createFakeRedis({
      keys: {
        "session:a": 1800,
        "revoked:a": 2592000,
        "guestfp:a": 2592000,
      },
      backlog: 10,
      zcard: 3,
    })

    const report = await auditRedisKeys(redis)
    const {exitCode, text} = renderReport(report)

    assert.equal(report.unboundedKeys.length, 0)
    assert.equal(exitCode, 0)
    assert.equal(report.presenceUsers, 3)
    assert.equal(report.presenceGuests, 3)
    assert.match(text, /session:\*/)
    assert.match(text, new RegExp(ONLINE_USERS_KEY))
    assert.match(text, new RegExp(ONLINE_GUESTS_KEY))
  })

  /**
   * lists the offending prefix for each unbounded key
   */
  it("lists the offending prefix for each unbounded key", async () => {
    const redis = createFakeRedis({keys: {"guestfp:x": -1, "trusted:u:d": -1}})

    const report: HygieneReport = await auditRedisKeys(redis, {prefixes: ["guestfp:*", "trusted:*"]})

    assert.equal(report.unboundedKeys.length, 2)
    assert.ok(report.unboundedKeys.some((entry) => entry.startsWith("guestfp:*")))
    assert.ok(report.unboundedKeys.some((entry) => entry.startsWith("trusted:*")))
  })
})
