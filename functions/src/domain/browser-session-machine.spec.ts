/* eslint-disable max-len */
/**
 * Pins the machine a browser session asks for.
 *
 * These are the properties §1.4 turns on, and each one is a way the platform
 * could quietly deploy something nobody chose:
 *
 *   1. the machine is named from the session id, so Fly's own uniqueness rule
 *      becomes the idempotency key and a machine traces back to its session;
 *   2. `imageOption` stays `"default"`, or arachnefly reads `dockerHubUrl`
 *      instead and the configured image is ignored;
 *   3. the size comes from a constant, so no request can pick its own cost;
 *   4. the machine stops itself, so an abandoned session cannot bill compute
 *      forever — which is the whole point of the reaper.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  BROWSER_MACHINE_SIZE,
  machineChargeFor,
  machineNameFor,
  machineRequestFor,
} from "./browser-session.domain"

describe("machineNameFor", () => {
  it("derives the name from the session id", () => {
    assert.equal(machineNameFor("abc-123"), "bs-abc-123")
  })

  it("starts with a letter even for an id that does not", () => {
    // A bare UUID begins with a hex digit, and Fly requires a machine name to
    // begin with a letter. The prefix is what makes the derivative safe.
    const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e"
    assert.match(machineNameFor(uuid), /^[a-z]/)
    assert.ok(machineNameFor(uuid).endsWith(uuid))
  })
})

describe("machineRequestFor", () => {
  it("names the machine after the session", () => {
    assert.equal(machineRequestFor("s1", "img", "iad").machineName, "bs-s1")
  })

  it("takes the image as the DEFAULT image", () => {
    // `imageOption` is a selector, not a label: "url" would send arachnefly to
    // `dockerHubUrl` and "upload" to `dockerfile`, so a wrong value here means
    // the configured image is never used and the request still succeeds.
    const request = machineRequestFor("s1", "registry.example/bs:1", "iad")
    assert.equal(request.imageOption, "default")
    assert.equal(request.defaultImage, "registry.example/bs:1")
  })

  it("carries the region it was given", () => {
    assert.equal(machineRequestFor("s1", "img", "fra").region, "fra")
  })

  it("asks for autostart paired with suspend", () => {
    // Both halves matter. Without `autoStop` Fly keeps an idle machine running,
    // which is the cost the reaper exists to stop; without `autoStart` a
    // suspended machine needs a redeploy to come back.
    const request = machineRequestFor("s1", "img", "iad")
    assert.equal(request.autoStart, true)
    assert.equal(request.autoStop, "suspend")
  })

  it("takes the guest size from the constant, not the caller", () => {
    const request = machineRequestFor("s1", "img", "iad")
    assert.equal(request.cpuCores, BROWSER_MACHINE_SIZE.cpuCores)
    assert.equal(request.cpuType, BROWSER_MACHINE_SIZE.cpuType)
    assert.equal(request.memory, BROWSER_MACHINE_SIZE.memory)
  })

  it("exposes exactly the fields arachnefly reads, and no sizing override", () => {
    const request = machineRequestFor("s1", "img", "iad")
    assert.deepEqual(Object.keys(request).sort(), [
      "autoStart",
      "autoStop",
      "cpuCores",
      "cpuType",
      "defaultImage",
      "imageOption",
      "machineName",
      "memory",
      "region",
    ])
  })
})

/**
 * The money decision.
 *
 * This is the half of §1.4 that is easy to get wrong quietly: the route runs on
 * `access`, which bills nothing, so if this returns null the machine is free and
 * nothing anywhere reports it. The deploy action is what a manual deploy costs,
 * so the amounts below are read from the caller rather than written here — a
 * literal in this test would pass while the platform charged something else.
 */
describe("machineChargeFor", () => {
  const price = {action: "machines.deploy", credits: 5}

  it("charges a credit caller from the purchased pot", () => {
    const charge = machineChargeFor("credits", price)

    assert.deepEqual(charge, {
      amount: 5,
      bucket: "purchased",
      action: "machines.deploy",
    })
  })

  it("charges a plan caller from the included pot", () => {
    const charge = machineChargeFor("plan", price)

    assert.equal(charge?.bucket, "included")
  })

  it("uses the price it is given rather than a literal of its own", () => {
    // The table is env-overridable (`BILLING_PRICING_RULES_JSON`), so the
    // amount has to travel from the row to the charge with nothing in between.
    const charge = machineChargeFor("credits", {action: "x", credits: 42})

    assert.equal(charge?.amount, 42)
    assert.equal(charge?.action, "x")
  })

  it("does not charge a free caller", () => {
    // Unreachable in practice — `decideLease` refuses a dedicated session for a
    // free tier, so no machine is ever asked for — and refused here anyway, so
    // the cap is not the only thing standing between free and a free machine.
    assert.equal(machineChargeFor("free", price), null)
  })

  it("does not charge an admin, the platform bypass", () => {
    assert.equal(machineChargeFor("admin", price), null)
  })

  it("does not charge a caller in grace", () => {
    // Grace keeps ACCESS without being billed, which is what the charge gate
    // naming only `credits` and `plan` means.
    assert.equal(machineChargeFor("grace", price), null)
  })

  it("does not charge when no access mode was resolved", () => {
    assert.equal(machineChargeFor(undefined, price), null)
  })

  it("does not charge when the row prices the action at zero", () => {
    // A row set to 0 is how someone would turn the charge off, and a
    // reservation of nothing is a ledger entry for nothing.
    assert.equal(machineChargeFor("credits", {action: "a", credits: 0}), null)
    assert.equal(machineChargeFor("credits", {action: "a", credits: -1}), null)
    assert.equal(
      machineChargeFor("credits", {action: "a", credits: Number.NaN}),
      null,
    )
  })
})
