/* eslint-disable max-len */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {join} from "node:path"

/**
 * Round-trip budget for the heartbeat path.
 *
 * Every bare `await redis.x()` through the Upstash REST client is one HTTPS request,
 * so N sequential calls cost N round-trips. The hot path must batch through
 * `pipeline()` or the shared `redisEval` scripts instead.
 *
 * This is a ratchet, not a target: the budget applies to legacy/error paths
 * (device-mismatch dedupe, the backwards-compat login_history_Info fallback). The
 * regions below are asserted at zero, so a new sequential round-trip fails the build.
 */
const BARE_REDIS_BUDGET = 3

const countMatches = (source: string, pattern: RegExp): number =>
  [...source.matchAll(pattern)].length

/**
 * Slice out the code between two literal marker comments, failing loudly if either is gone.
 *
 * @param {string} source - File contents to search.
 * @param {string} startMarker - Literal marker to start after.
 * @param {string} endMarker - Literal marker to stop at.
 * @return {string} The slice between the markers.
 */
const betweenMarkers = (source: string, startMarker: string, endMarker: string): string => {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  assert.ok(start >= 0, `start marker not found: ${startMarker}`)
  assert.ok(end > start, `end marker not found after start: ${endMarker}`)
  return source.slice(start, end)
}

describe("redis round-trip budget", () => {
  const handler = readFileSync(join(__dirname, "home_handler.ts"), "utf8")

  it("does not add bare redis round-trips to the heartbeat", () => {
    const bare = countMatches(
      handler,
      /await redis\.(get|set|setex|del|zadd|zremrangebyscore|zcount|incr)\(/g,
    )

    assert.ok(
      bare <= BARE_REDIS_BUDGET,
      `home_handler.ts has ${bare} bare await redis.* calls (budget ${BARE_REDIS_BUDGET}). ` +
      "Batch them into redis.pipeline() or a single script call instead of adding round-trips.",
    )
  })

  it("keeps the session-validated region at zero extra round-trips", () => {
    // The validated branch used to pay a third round-trip (`setex` to refresh the
    // session TTL) on top of the read pipeline and the presence pipeline.
    const region = betweenMarkers(
      handler,
      "ONE round-trip for read + TTL refresh + revocation check",
      "// Fallback: Check loginSessions collection (slower path).",
    )

    assert.equal(
      countMatches(region, /await redis\./g),
      0,
      "the validated session path must not add bare redis round-trips",
    )
    assert.match(region, /READ_SESSION_WITH_TTL_REFRESH/)
  })

  it("keeps the presence region to a single script call", () => {
    const region = betweenMarkers(
      handler,
      "One script for presence liveness, sorted-set upsert, and stale trim",
      "Structured SLI",
    )

    assert.equal(
      countMatches(region, /await redisEval/g),
      1,
      "presence must be exactly one script call",
    )
    assert.equal(
      countMatches(region, /await redis\./g),
      0,
      "presence must not fall back to sequential commands",
    )
    // The dashboard summary has a single writer: the scheduled rollup.
    assert.ok(
      !region.includes("metrics_summary"),
      "the heartbeat must not write metrics_summary/dashboard",
    )
  })
})
