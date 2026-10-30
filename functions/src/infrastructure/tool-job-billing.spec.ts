/**
 * One tool job costs its tool's own listed price, and a tool with no listed
 * price costs nothing.
 *
 * The second half is the one worth a test. `resolveBillingPricingPolicy`
 * answers a fallback for an unlisted path, so a naive `charge whatever it
 * says` would have put a price on `serp`, `search`, `extract` and `pdf` --
 * four tools whose direct routes have always been free. A green test over the
 * spider price would not have noticed.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {toolJobCharge} from "../infrastructure/tool-job-billing"

describe("toolJobCharge", () => {
  it("prices a tool by its own row, not the fallback", () => {
    assert.deepEqual(toolJobCharge("/spider"), {
      action: "webrain.spider",
      credits: 10,
    })
    assert.deepEqual(toolJobCharge("/batch"), {
      action: "webrain.batch",
      credits: 3,
    })
    assert.deepEqual(toolJobCharge("/vision"), {
      action: "webrain.vision",
      credits: 2,
    })
    assert.deepEqual(toolJobCharge("/watch"), {
      action: "webrain.watch",
      credits: 5,
    })
  })

  it("charges nothing for a tool with no row of its own", () => {
    // `serp` is the free-tier tool, and the other three have never had a
    // price. Inventing one here would be a new price, not a bug fix.
    assert.equal(toolJobCharge("/serp"), null)
    assert.equal(toolJobCharge("/search"), null)
    assert.equal(toolJobCharge("/extract"), null)
    assert.equal(toolJobCharge("/pdf"), null)
  })

  it("cannot be priced by a route that is not a tool", () => {
    // Defence against a caller passing something shaped like a path with a
    // query or a traversal; `/` is the only route-shaped input `enqueueTool`
    // can build, and it must not resolve to a paid action.
    assert.equal(toolJobCharge("/"), null)
    assert.equal(toolJobCharge("/spider/../../crawl"), null)
  })
})
