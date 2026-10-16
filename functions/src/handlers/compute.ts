/* eslint-disable object-curly-spacing */
/**
 * The caller's own Fly organization: read it, replace it, clear it.
 *
 * Two routes, and neither can reach another tenant
 * ------------------------------------------------
 * The document path is derived from the VERIFIED uid, so there is no id in the
 * URL to guess or to tamper with -- the same isolation argument the egress and
 * storage routes make, and the reason this is a caller-scoped setting. A member
 * configuring it moves THEIR OWN machines; it does not move a colleague's.
 *
 * Why the guard is on `machine` and not a new action
 * -------------------------------------------------
 * The authz `machine` resource declares `read`, `deploy` and `update`, and
 * `bff/api.ts` already records that inventing an action means a policy
 * migration. None is needed here: this setting grants no authority over anybody
 * else, and a caller who cannot act on machines has nothing to point at a
 * compute source. So read takes `machine:read` and the write takes
 * `machine:update` -- the action this resource uses for mutating machine
 * configuration, while `deploy` stays reserved for actually deploying.
 *
 * `paid` is deliberately NOT in the guard, for the reason the egress route
 * gives: it would 402 a caller reading or clearing their OWN configuration, and
 * the machine routes themselves already require it. A caller who cannot deploy
 * gains nothing from this route either way.
 *
 * A BYO write is REFUSED today, and why that is the honest answer
 * --------------------------------------------------------------
 * The tenant axis EXISTS -- `resolveCompute` here, `DecideFlyTenant` beside it
 * in arachnefly -- but nothing CONSUMES it yet: every Fly call still signs with
 * the token the Go service read from its own environment at BOOT. A stored
 * tenant config would therefore create the caller's machines in OUR
 * organization while this page told them those machines were theirs. That is
 * the double-bill this whole axis was built to prevent, wearing a success
 * message.
 *
 * So storing the config is worse than refusing it: the caller gets a plausible
 * "saved" and nothing afterwards can tell them it did nothing. `byo` writes
 * answer 501 until the Go side consumes the decision -- the same fail-closed
 * shape `resolveBlobStore` uses when it returns null instead of substituting
 * the platform bucket. Reverse this the moment `DecideFlyTenant` has a caller.
 *
 * What may leave this file
 * ------------------------
 * Never a Fly token. The GET projects through `toPublicCompute`, which has no
 * field a token could occupy, and a validation failure names a REASON rather
 * than the value -- a message that quoted it would put a deploy token in the
 * response body and the log at once.
 */
import { Request, Response } from "express"

import { errorLabel, uidOf } from "./request-helpers"
import { validateComputeInput } from "../domain/byo-compute.domain"
import {
  readComputeSettings,
  writeComputeSettings,
} from "../infrastructure/compute-settings.store"

/**
 * `GET /api/compute` -- the caller's own Fly organization, credentialless.
 *
 * `mode` follows the POINTER rather than the parse, so a caller whose secret
 * has gone unreadable reads as `byo` with no credential. That is the honest
 * description of their state and it is the same condition the resolver refuses
 * on, which is what lets the UI say "configured, but not usable" rather than
 * "off".
 * @param {Request} req The request.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const getCompute = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)

  if (!uid) {
    res.status(401).json({ error: "unauthorized", code: "unauthorized" })
    return
  }

  try {
    res.status(200).json(await readComputeSettings(uid))
  } catch (error) {
    console.error("compute: read failed:", errorLabel(error))
    res.status(500).json({ error: "internal", code: "internal" })
  }
}

/**
 * `PUT /api/compute` -- replace the caller's Fly organization, or clear it.
 *
 * The body is `{mode: "byo", app, token, region}` or `{mode: "platform"}` to go
 * back to our machines. `mode` is required rather than inferred, because either
 * guess is wrong for somebody: reading an absent mode as "set" lets a typo
 * overwrite a working config, and reading it as "clear" silently moves the
 * caller's machines back onto our bill.
 *
 * A cleared config purges the secret, so "I removed my token" is true rather
 * than merely unevaluated.
 * @param {Request} req The request carrying the write.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const setCompute = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)

  if (!uid) {
    res.status(401).json({ error: "unauthorized", code: "unauthorized" })
    return
  }

  const validation = validateComputeInput(req.body)

  if (!validation.ok) {
    // A reason only -- the body carries a deploy token.
    res.status(400).json({
      error: "bad_request",
      code: "bad_request",
      reason: validation.reason,
    })
    return
  }

  // Refused AFTER validation so a malformed body still gets its specific
  // reason first, and BEFORE any secret is written: `writeComputeSettings` is
  // never reached, so no credential is stored for a config nothing consumes.
  if (validation.write.mode === "byo") {
    res.status(501).json({
      error: "compute_byo_unavailable",
      code: "compute_byo_unavailable",
    })
    return
  }

  try {
    res.status(200).json(await writeComputeSettings(uid, validation.write))
  } catch (error) {
    console.error("compute: write failed:", errorLabel(error))
    res.status(500).json({ error: "internal", code: "internal" })
  }
}
