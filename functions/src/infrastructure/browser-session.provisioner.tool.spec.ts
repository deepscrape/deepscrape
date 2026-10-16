/**
 * The request shape the machine-direct tool route sends.
 *
 * Its own file rather than an addition to `browser-session.provisioner.spec.frame.ts`,
 * which is the convention that file already follows: one spec per reader, because
 * the frame reader answers BYTES and this one answers JSON.
 *
 * Only the pure body builder is covered. `callMachineTool` itself fetches, and the
 * property that makes it safe to relay a caller's token to `/api/machine/mcp/:id`
 * -- arachnefly's ownership middleware checks the machine against that token --
 * belongs to the upstream rather than to this code.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {machineToolBody} from "./browser-session.provisioner"

describe("machineToolBody", () => {
  it("builds the tools/call the machine's own engine expects", () => {
    assert.deepEqual(
      machineToolBody("webrain_interact", {
        action: "click_coords",
        x: 12,
        y: 34,
      }),
      {
        jsonrpc: "2.0",
        id: "tool",
        method: "tools/call",
        params: {
          name: "webrain_interact",
          arguments: {action: "click_coords", x: 12, y: 34},
        },
      }
    )
  })

  it("forwards the arguments untouched, including an empty set", () => {
    // The ALLOWLIST is the tool NAME. Arguments belong to the tool's own schema,
    // and a second validator here would be a second opinion the engine never sees
    // -- and would reject arguments the engine accepts the moment the two drift.
    const body = machineToolBody("webrain_observe", {}) as {
      params: {arguments: unknown}
    }

    assert.deepEqual(body.params.arguments, {})
  })

  it("keeps a literal id: the transport answers one call at a time", () => {
    // The transport answers one call at a time, so a counter would imply a
    // multiplexing concern this module does not have.
    assert.equal(machineToolBody("webrain_observe", {}).id, "tool")
  })
})
