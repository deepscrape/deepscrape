/* eslint-disable max-len */
/**
 * Watching a session must extend its life, and must not extend it on every poll.
 *
 * Only `keepalive` used to push the idle deadline out, so the documented live-view
 * flow died at its TTL with an operator still watching. The naive fix — refresh on
 * every frame — writes to Firestore once per poll, several times a second.
 *
 * The two properties that have to hold together are therefore pinned here: a
 * near-deadline poll refreshes, a comfortable one does not, and a session whose
 * deadline has ALREADY passed is never refreshed. That last one is not tidiness:
 * the meter ends an over-budget session by setting `idleDeadline = now`, so a frame
 * refresh that ignored it would undo the cost ceiling one poll at a time.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {shouldRefreshOnWatch} from "../infrastructure/browser-session.store"

// One paid idle window: 15 minutes.
const WINDOW = 15 * 60 * 1000
const LAST_USED = 1_000_000
const started = {lastUsedAt: LAST_USED, idleDeadline: LAST_USED + WINDOW}

describe("watching keeps a session alive", () => {
  it("leaves a comfortable session alone", () => {
    // One minute in: 14 minutes of slack left, so no write.
    assert.equal(shouldRefreshOnWatch(started, LAST_USED + 60_000), false)
  })

  it("refreshes once the deadline is inside half the window", () => {
    // 8 minutes in, 7 minutes left — past the half-window mark.
    assert.equal(shouldRefreshOnWatch(started, LAST_USED + 8 * 60 * 1000), true)
  })

  it("does not refresh a session with no idle expiry", () => {
    // Admin and free tiers carry no deadline at all.
    assert.equal(shouldRefreshOnWatch({lastUsedAt: LAST_USED}, LAST_USED + 60_000), false)
  })

  it("never revives a session whose deadline has passed", () => {
    // What the meter writes when it stops a session for cost.
    const stopped = {lastUsedAt: LAST_USED, idleDeadline: LAST_USED + WINDOW}

    assert.equal(shouldRefreshOnWatch(stopped, LAST_USED + WINDOW), false)
    assert.equal(shouldRefreshOnWatch(stopped, LAST_USED + WINDOW + 1), false)
  })
})
