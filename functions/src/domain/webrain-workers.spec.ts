/* eslint-disable max-len */
/**
 * Pins the browser-worker pool's selection rule.
 *
 * The case that carries the weight is the port collision in `workerLabel`.
 * `labelFor` in the proxy module names an entry by hostname, which is correct
 * for a proxy pool and wrong for a worker pool: several workers routinely share
 * one host on different ports. A hostname-only label would collapse
 * `127.0.0.1:9223` and `127.0.0.1:9224` into one lease key, and two tenants
 * would each be told they hold that worker exclusively -- a cross-tenant leak
 * arising from a display string, which is why it is tested rather than assumed.
 *
 * The second weight-bearing case is the refusal. `all_workers_busy` must be a
 * refusal and never a share; the whole point of the pool is that exclusivity
 * survives contention.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  leaseGrantedBy,
  selectWorker,
  workerLabel,
  workerLeaseKey,
  workerLeaseRedisKey,
  type WorkerEntry,
} from "./webrain-workers.domain"

/** Two workers on ONE host, which is the shape that breaks a hostname label. */
const LOCAL_POOL: WorkerEntry[] = [
  {label: "127.0.0.1:9223", url: "http://127.0.0.1:9223"},
  {label: "127.0.0.1:9224", url: "http://127.0.0.1:9224"},
]

/** No leases held. */
const NONE_BUSY: ReadonlySet<string> = new Set<string>()

describe("workerLabel", () => {
  it("keeps the port, so one host is not one worker", () => {
    assert.equal(workerLabel("http://127.0.0.1:9223", 0), "127.0.0.1:9223")
    assert.equal(workerLabel("http://127.0.0.1:9224", 1), "127.0.0.1:9224")
    assert.notEqual(
      workerLabel("http://127.0.0.1:9223", 0),
      workerLabel("http://127.0.0.1:9224", 1)
    )
  })

  it("drops the port only when the URL has none", () => {
    assert.equal(workerLabel("https://workers.example.com", 0), "workers.example.com")
  })

  it("falls back to the position, never to the raw string", () => {
    // A malformed entry is exactly where a credential could reach an admin
    // table, so the fallback must not echo what it could not parse.
    assert.equal(workerLabel("", 0), "worker-1")
    assert.equal(workerLabel("not a url", 1), "worker-2")

    // And the case that is NOT a throw, which is the one that caught a real
    // bug: `new URL` accepts a credential-shaped string as scheme `user:` with
    // an empty hostname. Trusting the parse alone returned an EMPTY label here,
    // which collapses two entries into one display row.
    assert.equal(workerLabel("user:pass@host", 2), "worker-3")
    assert.equal(workerLabel("file:///tmp/socket", 3), "worker-4")
  })
})

describe("workerLeaseKey", () => {
  it("is the URL, so the key is as unique as the endpoint", () => {
    assert.equal(workerLeaseKey(LOCAL_POOL[0]), "http://127.0.0.1:9223")
  })
})

describe("selectWorker", () => {
  it("takes the first idle worker in configured order", () => {
    const picked = selectWorker(LOCAL_POOL, NONE_BUSY)
    assert.equal(picked.ok, true)
    assert.ok(picked.ok)
    assert.equal(picked.key, "http://127.0.0.1:9223")
  })

  it("skips a leased worker and takes the next", () => {
    const picked = selectWorker(LOCAL_POOL, new Set(["http://127.0.0.1:9223"]))
    assert.ok(picked.ok)
    assert.equal(picked.key, "http://127.0.0.1:9224")
  })

  it("keeps two workers on one host independently leasable", () => {
    // The regression this file exists for: if both entries produced one key,
    // leasing the first would make the second look busy too.
    const first = selectWorker(LOCAL_POOL, NONE_BUSY)
    assert.ok(first.ok)
    const second = selectWorker(LOCAL_POOL, new Set([first.key]))
    assert.ok(second.ok)
    assert.notEqual(second.key, first.key)
  })

  it("refuses when no pool is configured", () => {
    const picked = selectWorker([], NONE_BUSY)
    assert.equal(picked.ok, false)
    assert.ok(!picked.ok)
    assert.equal(picked.reason, "no_workers_configured")
  })

  it("refuses rather than sharing when every worker is leased", () => {
    const all = new Set(LOCAL_POOL.map(workerLeaseKey))
    const picked = selectWorker(LOCAL_POOL, all)
    assert.equal(picked.ok, false)
    assert.ok(!picked.ok)
    assert.equal(picked.reason, "all_workers_busy")
  })

  it("does not mutate the pool it is given", () => {
    const pool: WorkerEntry[] = [...LOCAL_POOL]
    selectWorker(pool, new Set(["http://127.0.0.1:9223"]))
    assert.equal(pool.length, 2)
    assert.equal(pool[0].url, "http://127.0.0.1:9223")
  })
})

describe("workerLeaseRedisKey", () => {
  it("is distinct per endpoint, so one host can hold two leases", () => {
    assert.notEqual(
      workerLeaseRedisKey(LOCAL_POOL[0]),
      workerLeaseRedisKey(LOCAL_POOL[1])
    )
    assert.equal(
      workerLeaseRedisKey(LOCAL_POOL[0]),
      "webrain:workers:lease:http://127.0.0.1:9223"
    )
  })
})

describe("leaseGrantedBy", () => {
  it("accepts only a holder token, never a status", () => {
    // The asymmetry here is deliberate and is why the claim goes through
    // `eval`: the no-op client answers "OK" to `set`, so a claim written
    // against a command's status would have granted a lease with no Redis
    // configured at all. `eval` answers an array instead, and an array is
    // refused.
    assert.equal(leaseGrantedBy("call-abc"), true)
    assert.equal(leaseGrantedBy([null, "ok"]), false)
  })

  it("refuses an absent, empty or non-string reply", () => {
    // null is the real refusal shape from `SET ... NX`; the rest guard against
    // a caller passing through something that only looks truthy.
    assert.equal(leaseGrantedBy(null), false)
    assert.equal(leaseGrantedBy(undefined), false)
    assert.equal(leaseGrantedBy(""), false)
    assert.equal(leaseGrantedBy(0), false)
    assert.equal(leaseGrantedBy(false), false)
  })
})
