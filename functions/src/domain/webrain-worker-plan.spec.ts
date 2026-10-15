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
 *
 * The other case worth pinning is the FIRST branch: a caller who has leased a
 * machine gets THEIR machine, ahead of the pool. Getting that order wrong would
 * not leak anything, which is exactly why it could go unnoticed -- it would
 * silently hand them a platform worker's browser instead of the session they are
 * watching and paying for.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  planWorkerAcquisition,
  type OwnMachine,
  type WorkerEntry,
} from "./webrain-workers.domain"

/** Two workers, in the order an operator configured them. */
const POOL: WorkerEntry[] = [
  {label: "10.0.0.4:9223", url: "http://10.0.0.4:9223"},
  {label: "10.0.0.5:9223", url: "http://10.0.0.5:9223"},
]

/** One machine a caller leased for a session. */
const MACHINE: OwnMachine = {machineId: "3900abc", sessionId: "sess-1"}

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

  it("uses the caller's own machine in preference to a configured pool", () => {
    const plan = planWorkerAcquisition(
      POOL,
      "http://127.0.0.1:9223",
      MACHINE
    )
    assert.equal(plan.kind, "use-own-machine")
    assert.ok(plan.kind === "use-own-machine")
    assert.deepEqual(plan.machine, MACHINE)
  })

  it("uses the caller's own machine when no platform worker exists at all", () => {
    // Not a `refuse`: a machine is a source in its own right, so a caller who
    // has one must not be told no worker is configured.
    const plan = planWorkerAcquisition([], "", MACHINE)
    assert.equal(plan.kind, "use-own-machine")
  })

  it("does not put a call on a machine when the caller has none", () => {
    const plan = planWorkerAcquisition(POOL, "", undefined)
    assert.equal(plan.kind, "try-pool")
  })

  it("still refuses when there is no machine, no pool and no single worker", () => {
    const plan = planWorkerAcquisition([], "", undefined)
    assert.equal(plan.kind, "refuse")
  })
})
