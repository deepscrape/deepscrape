import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {FrameThrottle} from "./frame-throttle"

describe("frame throttle", () => {
  it("lets a paid session have its first frame", () => {
    const throttle = new FrameThrottle()
    assert.equal(throttle.frameRefused("u:s", "paid", 1_000), false)
  })

  it("refuses a second frame inside the tier's pace", () => {
    const throttle = new FrameThrottle()
    throttle.frameRefused("u:s", "paid", 1_000)
    assert.equal(throttle.frameRefused("u:s", "paid", 1_500), true)
  })

  it("allows the next frame once the interval has passed", () => {
    const throttle = new FrameThrottle()
    throttle.frameRefused("u:s", "paid", 1_000)
    assert.equal(throttle.frameRefused("u:s", "paid", 2_000), false)
  })

  // A stamped refusal would push every later frame out by a full interval, so a caller who
  // polls too fast would drift further behind with each attempt.
  it("does not stamp a refused request", () => {
    const throttle = new FrameThrottle()
    throttle.frameRefused("u:s", "paid", 1_000)
    assert.equal(throttle.frameRefused("u:s", "paid", 1_500), true)
    assert.equal(throttle.frameRefused("u:s", "paid", 2_000), false)
  })

  it("gives each session its own pace", () => {
    const throttle = new FrameThrottle()
    throttle.frameRefused("u:one", "paid", 1_000)
    assert.equal(throttle.frameRefused("u:two", "paid", 1_000), false)
  })

  // The free tier has no frame budget at all, so even the first request is refused.
  it("refuses every frame on the free tier", () => {
    const throttle = new FrameThrottle()
    assert.equal(throttle.frameRefused("u:s", "free", 1_000), true)
    assert.equal(throttle.frameRefused("u:s", "free", 60_000), true)
  })

  // Eviction must drop the LEAST recently served key. `set` on an existing key keeps its
  // original insertion position, so without the delete a session that just polled would
  // still be evicted next, and its refusal history would be forgotten.
  it("keeps the pace of a session that just polled", () => {
    const throttle = new FrameThrottle()
    throttle.frameRefused("hot", "paid", 1_000)

    for (let i = 0; i < 1_999; i += 1) {
      throttle.frameRefused(`cold-${i}`, "paid", 1_000)
    }

    // A full interval has passed, so this is allowed — and it must move "hot" to the back
    // of the eviction order.
    assert.equal(throttle.frameRefused("hot", "paid", 2_000), false)

    // One insert over the bound evicts the oldest entry, which is a cold session.
    throttle.frameRefused("cold-1999", "paid", 2_000)

    assert.equal(
      throttle.frameRefused("hot", "paid", 2_500),
      true,
      "the session that just polled must keep its pace through an eviction",
    )
  })
})
