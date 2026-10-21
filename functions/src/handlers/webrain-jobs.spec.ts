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

import {
  deriveStatus,
  finishedJobStatus,
  queueVerdict,
  terminalFrameStatus,
  type WebrainJobItem,
} from "./webrain-jobs"

/**
 * A landed target. Only the fields the status depends on are set.
 *
 * Each call gets its own url unless one is passed. `deriveStatus` counts DISTINCT
 * urls, so a fixture that reused one url would describe a job whose targets are
 * all the same page, and every "2 of 3" assertion in this file would read as one
 * target. Pass a url explicitly to model a RETRY, which appends a second row.
 * @param {*} status Whether this target succeeded.
 * @param {string} url The target url; a distinct one by default.
 * @return {*} The stored item shape.
 */
let landedSeq = 0
const landed = (status: "ok" | "error", url?: string): WebrainJobItem => ({
  url: url ?? `https://target-${landedSeq++}.test`,
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

  it("reads a stored publish failure as Failed, not In Progress", () => {
    // Nothing was queued, so no row can ever land: deriving from what ARRIVED
    // answered "In Progress" for ever for a job that never started.
    assert.equal(
      deriveStatus({ status: "Failed", items: [], total: 3 }),
      "Failed"
    )
  })

  it("keeps a stored publish failure even when rows did land", () => {
    // The other half of the same defect: one rejected publish marked the job
    // Failed while the rest of the messages were already in flight, and the
    // rows those landed read as Completed. The stored failure is the record of
    // the queue, so it outranks the arithmetic.
    assert.equal(
      deriveStatus({
        status: "Failed",
        items: [landed("ok")],
        total: 1,
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

describe("deriveStatus with retried targets", () => {
  // `runCrawlTarget` appends with `arrayUnion`, which discards only a value EQUAL
  // to one already present -- and a row carries `ms` and `data`, so a retry of
  // the same target never is equal and DOES append a second row for one url.
  // `total` counts urls, so the old row count was comparing two different things.

  it("does not count one retried target twice", () => {
    // Both targets failed, then one was retried and succeeded. Counting rows
    // gave failed=2 against total=2 and reported Failed for a job that had
    // collected a page.
    assert.equal(
      deriveStatus({
        status: "In Progress",
        items: [
          landed("error", "https://a.test"),
          landed("error", "https://b.test"),
          landed("ok", "https://a.test"),
        ],
        total: 2,
      }),
      "Completed"
    )
  })

  it("does not settle while a distinct target is still missing", () => {
    // The same inflation the other way: two rows for one url reached `total` and
    // settled the job, hiding a page that was still in flight.
    assert.equal(
      deriveStatus({
        status: "In Progress",
        items: [
          landed("ok", "https://a.test"),
          landed("ok", "https://a.test"),
        ],
        total: 2,
      }),
      "In Progress"
    )
  })

  it("reads the LAST row for a url, in both directions", () => {
    // Append order is retry order, so the newest outcome is the target's.
    assert.equal(
      deriveStatus({
        status: "In Progress",
        items: [
          landed("error", "https://a.test"),
          landed("ok", "https://a.test"),
        ],
        total: 1,
      }),
      "Completed"
    )
    assert.equal(
      deriveStatus({
        status: "In Progress",
        items: [
          landed("ok", "https://a.test"),
          landed("error", "https://a.test"),
        ],
        total: 1,
      }),
      "Failed"
    )
  })
})

describe("queueVerdict", () => {
  it("fails the job only when the queue took no target at all", () => {
    assert.deepEqual(queueVerdict(3, 0), {
      status: "Failed",
      message: "Could not queue the job",
    })
  })

  it("keeps a partially queued job open, and says how many went out", () => {
    // One rejected publish used to mark the whole job Failed while the others
    // were already in flight; the rows they landed then read as Completed for
    // the same job. Neither label describes what happened.
    assert.deepEqual(queueVerdict(50, 45), {
      status: "In Progress",
      message: "Queued 45 of 50 target(s)",
    })
  })

  it("says the plain count when every target was queued", () => {
    assert.deepEqual(queueVerdict(2, 2), {
      status: "In Progress",
      message: "Queued 2 target(s)",
    })
  })
})

describe("finishedJobStatus", () => {
  it("reports a job whose targets all landed, which nothing stores", () => {
    // `deriveStatus` computes "Completed" on read, so a stored "In Progress" is
    // the NORMAL state of a finished job -- the old guard compared against the
    // stored field and could never match.
    assert.equal(
      finishedJobStatus({
        status: "In Progress",
        items: [landed("ok", "https://a.test")],
        total: 1,
      }),
      "Completed"
    )
  })

  it("reports a job whose targets all failed", () => {
    // The case that actually relabelled finished work: every target landed as an
    // error, which is a settled FAILURE the old guard read as still open, so a
    // cancel overwrote it with "Canceled" permanently.
    assert.equal(
      finishedJobStatus({
        status: "In Progress",
        items: [landed("error", "https://a.test")],
        total: 1,
      }),
      "Failed"
    )
  })

  it("keeps the stored publish failure, which no row records", () => {
    // Nothing was ever queued, so no item can land. The stored "Failed" is the
    // only record of it, and `deriveStatus` honours it rather than deriving
    // "In Progress" for ever.
    assert.equal(
      finishedJobStatus({ status: "Failed", items: [], total: 3 }),
      "Failed"
    )
  })

  it("answers undefined while the job is still open", () => {
    assert.equal(
      finishedJobStatus({
        status: "In Progress",
        items: [landed("ok", "https://a.test")],
        total: 2,
      }),
      undefined
    )
  })

  it("does not treat an already-canceled job as finished", () => {
    // Cancelling twice stays idempotent: the route rewrites the same state and
    // reports success, rather than answering "already finished".
    assert.equal(
      finishedJobStatus({
        status: "Canceled",
        items: [landed("ok", "https://a.test")],
        total: 1,
      }),
      undefined
    )
  })

  it("does not treat a canceled, empty job as finished", () => {
    // The deliveries published before the cancel are still in flight. They are
    // skipped, not accounted for, so this job has no rows -- and the second
    // cancel must still answer "canceled", not "already finished".
    assert.equal(
      finishedJobStatus({ status: "Canceled", items: [], total: 4 }),
      undefined
    )
  })
})

describe("terminalFrameStatus", () => {
  it("has NO closing frame while the job is unfinished", () => {
    // The defect this pins: "In Progress" used to fall through to `completed`,
    // so a job that had landed 0 of 50 targets announced success — and because
    // the client keeps the last frame it is sent, that claim stuck.
    assert.equal(terminalFrameStatus("In Progress"), undefined)
  })

  it("maps the three settled statuses", () => {
    assert.equal(terminalFrameStatus("Completed"), "completed")
    assert.equal(terminalFrameStatus("Failed"), "error")
    assert.equal(terminalFrameStatus("Canceled"), "canceled")
  })
})
