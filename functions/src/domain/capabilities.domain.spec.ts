/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The axis logic, because it is the part that fails silently.
 *
 * A wrong entitlement here does not throw: it either lets a free caller spend
 * the platform's money on every request, or refuses a paying customer with a
 * 402 they cannot act on. And `admin` bypasses every row by design, which is
 * exactly the sort of deliberate exception that a later refactor removes
 * without noticing -- so it is pinned here rather than left implicit.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  CAPABILITIES,
  requirementFor,
  quotaLimitFor,
  satisfiesEntitlement,
  type Capability,
} from "./capabilities.domain"

describe("entitlement on the free row", () => {
  it("admits free, credits, plan and admin", () => {
    assert.equal(satisfiesEntitlement("free", "free"), true)
    assert.equal(satisfiesEntitlement("free", "credits"), true)
    assert.equal(satisfiesEntitlement("free", "plan"), true)
    assert.equal(satisfiesEntitlement("free", "admin"), true)
  })

  it("treats an unresolved entitlement as free, not as paid", () => {
    // `undefined` is the pre-billing state. Reading it as paid would hand a
    // signed-in user the paid surface before their billing document loaded.
    assert.equal(satisfiesEntitlement("free", undefined), true)
  })
})

describe("entitlement on the paid row", () => {
  it("refuses free and undefined", () => {
    assert.equal(satisfiesEntitlement("paid", "free"), false)
    assert.equal(satisfiesEntitlement("paid", undefined), false)
  })

  it("admits credits, plan and grace", () => {
    assert.equal(satisfiesEntitlement("paid", "credits"), true)
    assert.equal(satisfiesEntitlement("paid", "plan"), true)
    assert.equal(satisfiesEntitlement("paid", "grace"), true)
  })

  it("counts any unrecognised mode as paid, matching isPaidAccess", () => {
    // A new billing mode must fail closed in the other direction: appearing to
    // be paid is recoverable, silently reading as free is not.
    assert.equal(satisfiesEntitlement("paid", "some-future-mode"), true)
  })
})

describe("admin", () => {
  it("bypasses every row", () => {
    // Deliberate: an operator diagnosing a tenant needs the tool that failed.
    assert.equal(satisfiesEntitlement("free", "admin"), true)
    assert.equal(satisfiesEntitlement("paid", "admin"), true)
    assert.equal(satisfiesEntitlement("admin", "admin"), true)
  })

  it("is refused to everyone else", () => {
    assert.equal(satisfiesEntitlement("admin", "plan"), false)
    assert.equal(satisfiesEntitlement("admin", "credits"), false)
    assert.equal(satisfiesEntitlement("admin", "free"), false)
  })
})

describe("quotas", () => {
  it("applies the free ceiling to free and the paid ceiling above it", () => {
    assert.equal(quotaLimitFor("monitor", "free"), 20)
    assert.equal(quotaLimitFor("monitor", undefined), 20)
    assert.equal(quotaLimitFor("monitor", "plan"), 200)
    assert.equal(quotaLimitFor("monitor", "admin"), 200)
  })

  it("returns Infinity for a capability with no quota", () => {
    // Not zero: a missing quota means no ceiling, and returning 0 here would
    // make an ungated capability unusable by everyone.
    assert.equal(quotaLimitFor("ai.execute", "plan"), Infinity)
    assert.equal(quotaLimitFor("ai.execute", "free"), Infinity)
  })
})

describe("the table itself", () => {
  it("pins the two cost-structure decisions that are easy to reverse by accident", () => {
    // Stateless webrain calls are a CPU burst plus egress, which a shared pool
    // absorbs -- so they are free. The capacity-bearing ones are not.
    assert.equal(requirementFor("webrain.stateless").entitlement, "free")
    assert.equal(requirementFor("crawl.execute").entitlement, "paid")
    // Egress is charged for OURS, never for theirs. A platform entry spends our
    // bandwidth and our IP reputation; the caller's own spends neither, so
    // gating BYOP would tax the path that costs us least.
    assert.equal(requirementFor("proxy.platform").entitlement, "paid")
    assert.equal(requirementFor("proxy.byop").entitlement, "free")
  })

  it("declares a known entitlement for every row", () => {
    const allowed = ["free", "paid", "admin"]
    for (const [name, row] of Object.entries(CAPABILITIES)) {
      assert.ok(
        allowed.includes(row.entitlement),
        `${name} declares an unknown entitlement: ${row.entitlement}`
      )
    }
  })

  it("keeps quoting the RBAC pair rather than inventing a second policy", () => {
    // These strings must stay in step with `POLICIES` in authz.domain.ts, which
    // is where they are actually enforced.
    assert.deepEqual(requirementFor("crawl.execute").permission, {
      resource: "crawl",
      action: "execute",
    })
    assert.deepEqual(requirementFor("machine.deploy").permission, {
      resource: "machine",
      action: "deploy",
    })
  })

  it("covers every declared capability", () => {
    const names: Capability[] = [
      "ai.execute",
      "ai.byok",
      "crawl.execute",
      "webrain.stateless",
      "monitor",
      "proxy.platform",
      "proxy.byop",
      "machine.deploy",
    ]
    for (const name of names) {
      assert.ok(requirementFor(name), `missing row for ${name}`)
    }
  })
})
