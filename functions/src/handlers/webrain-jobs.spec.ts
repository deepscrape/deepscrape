/* eslint-disable object-curly-spacing */
/**
 * The derived job status.
 *
 * One message per target means the workers finish out of order and none of them
 * can know it was the last. The status is therefore computed on read from what
 * has landed, and this is the only place that decides whether a customer sees
 * "In Progress", "Completed" or "Failed" — the dashboard renders whatever this
 * returns, verbatim.
 *
 * A partial success is the case worth pinning: 47 of 50 targets landing is a
 * Completed job with three failures, not a Failed one, and getting that
 * backwards tells a paying customer their work was lost when it was not.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"

import { deriveStatus, type WebrainJobItem } from "./webrain-jobs"

/**
 * A landed target. Only the fields the status depends on are set.
 * @param {*} status Whether this target succeeded.
 * @return {*} The stored item shape.
 */
const landed = (status: "ok" | "error"): WebrainJobItem => ({
  url: "https://example.test",
  status,
  message: status === "ok" ? "" : "The provider returned no result",
  challenge: null,
})

describe("deriveStatus", () => {
  it("is In Progress until every target has landed", () => {
    assert.equal(
      deriveStatus({
        status: "In Progress",
        items: [landed("ok"), landed("ok")],
        total: 3,
      }),
      "In Progress"
    )
  })

  it("is In Progress when nothing has landed yet", () => {
    assert.equal(
      deriveStatus({ status: "In Progress", items: [], total: 5 }),
      "In Progress"
    )
  })

  it("is Completed when every target succeeded", () => {
    assert.equal(
      deriveStatus({
        status: "In Progress",
        items: [landed("ok"), landed("ok")],
        total: 2,
      }),
      "Completed"
    )
  })

  it("is Completed, not Failed, when some targets failed", () => {
    // The whole point: partial work is real work.
    assert.equal(
      deriveStatus({
        status: "In Progress",
        items: [landed("ok"), landed("ok"), landed("error")],
        total: 3,
      }),
      "Completed"
    )
  })

  it("is Failed only when no target succeeded", () => {
    assert.equal(
      deriveStatus({
        status: "In Progress",
        items: [landed("error"), landed("error")],
        total: 2,
      }),
      "Failed"
    )
  })

  it("honours a cancellation over whatever the counts say", () => {
    // Cancel is a user decision, so it outranks the derivation — otherwise a
    // canceled job that happened to finish would report Completed.
    assert.equal(
      deriveStatus({
        status: "Canceled",
        items: [landed("ok"), landed("ok")],
        total: 2,
      }),
      "Canceled"
    )
  })
})
