/* eslint-disable object-curly-spacing */
/**
 * The rules a BYO egress pool has to hold, pinned without I/O.
 *
 * Two of these are load-bearing rather than descriptive. `egressFrom` must keep
 * `undefined` and `null` apart -- one means "use the platform pool" and the
 * other means "refuse", and conflating them would put a caller who configured
 * their own exit back onto our addresses without telling them. And nothing that
 * leaves this module may contain a proxy password, in any field, including an
 * error message.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_EGRESS,
  egressFrom,
  egressSecretId,
  parseEgressPool,
  serializeEgressPool,
  toPublicEgress,
  validateEgressInput,
} from "./byo-egress.domain"

/** A URL carrying a password, which is what every assertion here guards. */
const WITH_SECRET = "http://alice:hunter2@exit.example.com:8080"

describe("byo egress: the secret id", () => {
  it("namespaces one secret per caller", () => {
    assert.equal(egressSecretId("abc"), "egress-byo-abc")
    assert.notEqual(egressSecretId("abc"), egressSecretId("abd"))
  })
})

describe("byo egress: resolving which pool to use", () => {
  it("uses the platform pool when the caller has no pointer", () => {
    // `undefined` is the ABSENCE of a pointer, not a failure.
    assert.deepEqual(egressFrom(undefined), {kind: "platform"})
  })

  it("refuses when a pointer exists but did not resolve", () => {
    // The fail-closed case: the caller configured their own exit, so falling
    // back to our addresses would silently undo the thing they configured for.
    assert.deepEqual(egressFrom(null), {kind: "unusable"})
    assert.deepEqual(egressFrom([]), {kind: "unusable"})
  })

  it("uses the caller's own pool when it resolves", () => {
    const resolved = egressFrom([WITH_SECRET])

    assert.equal(resolved.kind, "tenant")
    if (resolved.kind !== "tenant") {
      return
    }

    assert.equal(resolved.pool.length, 1)
    // The worker needs the credential, so the pool keeps the full URL...
    assert.equal(resolved.pool[0].url, WITH_SECRET)
    // ...and the label is the masked host, because a label reaches a log.
    assert.equal(resolved.pool[0].label, "exit.example.com:8080")
  })
})

describe("byo egress: the stored payload", () => {
  it("round trips a pool", () => {
    const raw = serializeEgressPool([WITH_SECRET])
    assert.deepEqual(parseEgressPool(raw), [WITH_SECRET])
  })

  it("uses the same shape the platform secret uses", () => {
    assert.deepEqual(JSON.parse(serializeEgressPool([])), {proxies: []})
  })

  it("refuses anything that is not a usable pool", () => {
    const rejected: unknown[] = [
      undefined,
      null,
      42,
      "",
      "   ",
      "not json",
      JSON.stringify({}),
      JSON.stringify({proxies: "nope"}),
      // An empty list is BROKEN, not "no proxy": the pointer already said the
      // caller has their own exits, so there is no fallback to make.
      JSON.stringify({proxies: []}),
      // One bad entry poisons the set rather than being skipped.
      JSON.stringify({proxies: [WITH_SECRET, "ftp://nope"]}),
    ]

    for (const raw of rejected) {
      assert.equal(parseEgressPool(raw), null, `should refuse: ${String(raw)}`)
    }
  })

  it("re-validates the protocol on the way out, not just the way in", () => {
    // A secret can be hand-edited or restored from a backup, so a stored value
    // is input like any other.
    const handEdited = JSON.stringify({proxies: ["file:///etc/passwd"]})
    assert.equal(parseEgressPool(handEdited), null)
  })
})

describe("byo egress: validating a write", () => {
  it("accepts an explicit clear", () => {
    const check = validateEgressInput({mode: "platform"})

    assert.equal(check.ok, true)
    if (check.ok) {
      assert.deepEqual(check.write, {mode: "platform"})
    }
  })

  it("accepts a pool of bare URLs", () => {
    // URLs only: the caller authors no label, because the write drops it and the
    // read derives one from the host.
    const check = validateEgressInput({
      mode: "byo",
      proxies: [WITH_SECRET],
    })

    assert.equal(check.ok, true)
    if (check.ok) {
      assert.deepEqual(check.write, {mode: "byo", proxies: [WITH_SECRET]})
    }
  })

  it("refuses a body that does not state its mode", () => {
    // Neither guess is safe: reading it as "set" lets a typo clear a working
    // pool, and reading it as "clear" drops the caller onto our addresses.
    const check = validateEgressInput({proxies: [{url: WITH_SECRET}]})

    assert.equal(check.ok, false)
    if (!check.ok) {
      assert.equal(check.index, -1)
      assert.match(check.reason, /mode must be/)
    }
  })

  it("refuses an empty pool that claims to be BYO", () => {
    // `validateProxyInput` refuses it, and for the tenant that refusal is
    // correct too: clearing has its own mode, so an empty list is a mistake.
    const check = validateEgressInput({mode: "byo", proxies: []})
    assert.equal(check.ok, false)
  })

  it("names the offending index and never the entry", () => {
    const check = validateEgressInput({
      mode: "byo",
      proxies: [WITH_SECRET, "ftp://bad.example.com"],
    })

    assert.equal(check.ok, false)
    if (!check.ok) {
      assert.equal(check.index, 1)
      // The reason is a fixed string: a message that quoted the entry would put
      // a password in the response body and the log at once.
      assert.equal(check.reason.includes("hunter2"), false)
      assert.equal(check.reason.includes("exit.example.com"), false)
    }
  })
})

describe("byo egress: the caller-facing projection", () => {
  it("reports the platform default with no exits", () => {
    assert.deepEqual(
      toPublicEgress({mode: "platform", pool: []}),
      DEFAULT_EGRESS
    )
  })

  it("masks every exit and reports presence", () => {
    const body = toPublicEgress({
      mode: "byo",
      pool: [{label: "exit.example.com:8080", url: WITH_SECRET}],
    })

    assert.equal(body.mode, "byo")
    assert.equal(body.hasCredentials, true)
    assert.deepEqual(body.exits, [
      {label: "exit.example.com:8080", host: "exit.example.com:8080"},
    ])

    // The whole point: no field may carry the password or the user name.
    const rendered = JSON.stringify(body)
    assert.equal(rendered.includes("hunter2"), false)
    assert.equal(rendered.includes("alice"), false)
    assert.equal(rendered.includes("http://"), false)
  })
})
