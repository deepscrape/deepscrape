/* eslint-disable max-len */
/**
 * Pins the order in which a browser-backed call looks for a worker.
 *
 * The case that carries the weight is the second one: with a pool configured,
 * a `singleUrl` must NOT be reachable. If it were, a fully busy pool would
 * quietly fall back to the shared single worker -- reintroducing exactly the
 * cross-tenant sharing (invariant I2) the pool exists to remove, and doing it
 * precisely when contention is highest, so it would look like "the pool got
 * busy" rather than like a leak.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  planWorkerAcquisition,
  type WorkerEntry,
} from "./webrain-workers.domain"

/** Two workers, in the order an operator configured them. */
const POOL: WorkerEntry[] = [
  {label: "10.0.0.4:9223", url: "http://10.0.0.4:9223"},
  {label: "10.0.0.5:9223", url: "http://10.0.0.5:9223"},
]

describe("planWorkerAcquisition", () => {
  it("tries the pool in configured order when one is configured", () => {
    const plan = planWorkerAcquisition(POOL, "")
    assert.equal(plan.kind, "try-pool")
    assert.ok(plan.kind === "try-pool")
    assert.deepEqual(
      plan.order.map((entry) => entry.url),
      ["http://10.0.0.4:9223", "http://10.0.0.5:9223"]
    )
  })

  it("never falls back to the single worker once a pool exists", () => {
    const plan = planWorkerAcquisition(POOL, "http://127.0.0.1:9223")
    assert.equal(plan.kind, "try-pool")
  })

  it("uses the single worker only when no pool is configured", () => {
    const plan = planWorkerAcquisition([], "http://127.0.0.1:9223")
    assert.equal(plan.kind, "use-single")
    assert.ok(plan.kind === "use-single")
    assert.equal(plan.url, "http://127.0.0.1:9223")
  })

  it("refuses when there is neither a pool nor a single worker", () => {
    const plan = planWorkerAcquisition([], "")
    assert.equal(plan.kind, "refuse")
    assert.ok(plan.kind === "refuse")
    assert.equal(plan.reason, "no_workers_configured")
  })

  it("does not mutate the pool it is handed", () => {
    const pool: WorkerEntry[] = [...POOL]
    planWorkerAcquisition(pool, "")
    assert.equal(pool.length, 2)
  })
})
