/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The compute route REFUSES a BYO write, and that refusal is the contract.
 *
 * Why this is pinned at the ROUTE and not only in the domain
 * ---------------------------------------------------------
 * `byo-compute.domain.spec.ts` proves the shapes; it cannot prove that a VALID
 * `byo` body stops before a credential is written. The gate exists because
 * nothing consumes the tenant yet -- `DecideFlyTenant` has no caller in
 * arachnefly -- so a stored config would create the caller's machines in OUR
 * organization while the settings page called them theirs. An edit that moved
 * the check below `writeComputeSettings`, or dropped it because "the domain
 * already validates this", would keep every domain test green and ship the
 * double-bill. It is measured here instead.
 *
 * Only the paths that SHORT-CIRCUIT are asserted: 401, 400 and the 501. The
 * `platform` path reaches Firestore and Secret Manager, which a unit spec must
 * not touch, and no unit spec can honestly cover it.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import type {Request, Response} from "express"

import {setCompute} from "./compute"

/** The status and body one call produced. */
type Captured = {status: number; body: unknown}

/**
 * A `Response` that records instead of writing.
 *
 * `Record<string, unknown>` rather than `Response`: `status` and `json` must
 * return the response so the handler can CHAIN them (`res.status(400).json(…)`),
 * which makes the object reference itself -- and a self-referencing initializer
 * without an annotation is a `noImplicitAny` error, not a style choice.
 * @return {*} The recorder and the fake response.
 */
const capture = () => {
  const captured: Captured = {status: 0, body: undefined}
  const res: Record<string, unknown> = {}

  res["status"] = (code: number) => {
    captured.status = code
    return res
  }

  res["json"] = (payload: unknown) => {
    captured.body = payload
    return res
  }

  return {captured, res}
}

/**
 * A BYO body that PASSES validation, so the refusal is the thing measured.
 *
 * Deliberately valid: a body that failed validation would produce the 400 and
 * prove nothing about the gate.
 */
const BYO_BODY = {mode: "byo", app: "my-app", token: "FlyV1-not-a-real-token", region: ""}

/**
 * One call, with the uid the auth middleware would have set.
 * @param {unknown} body The request body.
 * @param {string} [uid] The verified caller uid, omitted to simulate a token
 * that carried none.
 * @return {Promise<Captured>} The status and body the handler produced.
 */
const call = async (body: unknown, uid?: string) => {
  const {captured, res} = capture()
  const req = {user: uid ? {uid} : undefined, body}

  await setCompute(req as unknown as Request, res as unknown as Response)

  return captured
}

describe("setCompute", () => {
  it("answers 501 for a VALID byo write rather than storing it", async () => {
    const captured = await call(BYO_BODY, "uid-1")

    assert.equal(captured.status, 501)
    assert.deepEqual(captured.body, {
      error: "compute_byo_unavailable",
      code: "compute_byo_unavailable",
    })
  })

  it("answers 400, not 501, for a body that is malformed as well as byo", async () => {
    // The order matters: a caller with a broken body is told what is wrong with
    // the BODY, not told the feature is unavailable -- otherwise a typo reads as
    // a missing feature and they stop looking.
    const captured = await call({mode: "byo"}, "uid-1")

    assert.equal(captured.status, 400)
    assert.equal((captured.body as {code?: unknown}).code, "bad_request")
    assert.equal(typeof (captured.body as {reason?: unknown}).reason, "string")
  })

  it("answers 401 before it reads the body, when the token carried no uid", async () => {
    const captured = await call(BYO_BODY)

    assert.equal(captured.status, 401)
  })
})
