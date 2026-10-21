import {frameTooSoon} from "../domain/browser-session.domain"
import type {BrowserTier} from "../domain/browser-session.domain"

/** Bound on tracked sessions, because a Map keyed by session id is otherwise a leak. */
const MAX_TRACKED_SESSIONS = 2000

/**
 * Per-session frame pacing for the live view.
 *
 * Lives here rather than inline in the route because the route's module builds the Admin
 * SDK at load, so no test can import it. Every rule below was paid for once: the OLDEST
 * entry is evicted, because clearing the map forgets every pace at once, and a served
 * frame is re-inserted so the busiest key is not the first one evicted.
 */
export class FrameThrottle {
  private readonly lastFrameAtMs = new Map<string, number>()

  /**
   * Whether this caller must be refused now, recording the attempt when they may proceed.
   *
   * The DECISION is `frameTooSoon` in the domain, unmodified, so the fps table stays the
   * single source of truth and the free tier's refusal of even a first frame is not
   * restated here. This supplies only the input that predicate cannot compute: how long it
   * has been since the last frame this session served.
   * @param {string} key The uid and session id, so two callers cannot share a pace.
   * @param {BrowserTier} tier The caller's tier.
   * @param {number} nowMs The current time.
   * @return {boolean} True when the frame must be refused as too soon.
   */
  frameRefused(key: string, tier: BrowserTier, nowMs: number): boolean {
    const last = this.lastFrameAtMs.get(key)
    const sinceLast = last === undefined ? null : nowMs - last

    if (frameTooSoon(tier, sinceLast)) {
      return true
    }

    // Stamped only when a frame will actually be attempted. Stamping a refused request
    // would push the next allowed frame further out and compound it.
    if (this.lastFrameAtMs.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.lastFrameAtMs.keys().next().value
      if (oldest !== undefined) {
        this.lastFrameAtMs.delete(oldest)
      }
    }

    // Delete before setting so the key moves to the BACK of the insertion order: `set` on
    // an existing key keeps its original position, which made the most frequently polled
    // session the first one evicted -- and eviction forgets its pace, so the session that
    // actually pays the fps cap got a free frame.
    this.lastFrameAtMs.delete(key)
    this.lastFrameAtMs.set(key, nowMs)
    return false
  }
}
