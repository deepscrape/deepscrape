/* eslint-disable max-len */
/**
 * Ratchets on the Redis access patterns that were fixed for correctness.
 *
 * These are source-level assertions on purpose: the bugs they guard against were
 * races and round-trip counts, which a behavioural unit test can only reproduce
 * with a live Redis. Each assertion pins the mechanism that makes the property
 * hold, so removing the mechanism fails the build.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {join} from "node:path"

const sessionsSource = () => readFileSync(join(__dirname, "sessions.ts"), "utf8")

const countMatches = (source: string, pattern: RegExp): number =>
  [...source.matchAll(pattern)].length

/**
 * redis access patterns
 */
describe("redis access patterns", () => {
  /**
   * bounds the verification-code budget with one atomic increment
   */
  it("bounds the verification-code budget with one atomic increment", () => {
    const source = sessionsSource()

    assert.match(
      source,
      /FIXED_WINDOW_INCREMENT/,
      "the verification-code budget must use the atomic fixed-window script",
    )
    // The old shape read the counter, decided, then wrote it back — two concurrent
    // requests could both read the same value and both be admitted.
    assert.ok(
      !/rate_verification:/.test(source),
      "the verification-code counter key must come from the shared key builder",
    )
  })

  /**
   * never writes a Redis key without a TTL constant in the sessions module
   */
  it("never writes a Redis key without a TTL constant in the sessions module", () => {
    const source = sessionsSource()

    const bareSetex = countMatches(source, /await redis\.setex\(\s*`/g)
    assert.equal(
      bareSetex,
      0,
      "setex calls must be given a TTL and key from src/config/redis-keys.ts",
    )
    assert.ok(
      !/redis\.set\(/.test(source.replace(/\/\/ .*/g, "")),
      "redis.set has no expiry; use setex with a declared TTL",
    )
  })

  /**
   * keeps every session-cache write behind an existence guard
   */
  it("keeps every session-cache write behind an existence guard", () => {
    const source = sessionsSource()

    // A blind merge re-created keys that had already expired, resurrecting a
    // session Firestore had marked inactive.
    assert.match(
      source,
      /MERGE_SESSION_CACHE/,
      "the session cache merge must run in Redis, guarded by key existence",
    )
  })

  /**
   * batches the sign-out invalidation into one pipeline
   */
  it("batches the sign-out invalidation into one pipeline", () => {
    const source = sessionsSource()
    const region = source.slice(
      source.indexOf("One pipeline for the cache invalidation"),
      source.indexOf("One pipeline for the cache invalidation") + 600,
    )

    assert.ok(region.length > 0, "sign-out pipeline marker not found")
    assert.match(region, /signOutPipeline\.del\(/)
    assert.match(region, /signOutPipeline\.setex\(/)
  })
})
