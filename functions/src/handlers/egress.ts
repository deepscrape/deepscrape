/* eslint-disable object-curly-spacing */
/**
 * The caller's own egress pool: read it, replace it, clear it.
 *
 * Two routes, and neither can reach another tenant
 * ------------------------------------------------
 * The document path is derived from the VERIFIED uid, so there is no id in the
 * URL to guess or to tamper with -- the same isolation argument
 * `storage-settings.store.ts` makes, and the reason this is a caller-scoped
 * setting rather than an org one. A member configuring it changes where THEIR
 * OWN crawls appear from; it does not move a colleague's traffic.
 *
 * Why the guard is `crawl:execute` and NOT a new `crawl:write`
 * -----------------------------------------------------------
 * `crawl` declares only `execute` and `read`, and no role in POLICIES holds a
 * write on it. Adding an action means deciding who holds it, and that is an
 * entitlement decision: roadmap 12 records resource and action additions as an
 * open question rather than something to slip in beside a feature. It is also
 * not needed, because this setting grants no authority over anybody else. A
 * caller who cannot crawl has nothing to point at an egress, so everyone who can
 * run a crawl may say where their crawl goes out -- and nobody else can.
 *
 * What may leave this file
 * -----------------------
 * Never a proxy URL. The GET projects each exit down to `host:port` through the
 * masker the admin surface already uses, and a validation failure names an INDEX
 * and a fixed reason rather than the entry -- a message that quoted it would put
 * a password in the response body and in the log at once.
 */
import { Request, Response } from "express"

import { errorLabel, uidOf } from "./request-helpers"
import { validateEgressInput } from "../domain/byo-egress.domain"
import {
  readEgressSettings,
  writeEgressSettings,
} from "../infrastructure/egress-settings.store"

/**
 * `GET /api/egress` -- the caller's own exits, masked.
 *
 * `mode` follows the POINTER rather than the parse, so a caller whose secret has
 * gone unreadable reads as `byo` with no exits. That is the honest description
 * of their state and it is the same condition the resolver refuses on, which is
 * what lets the UI say "configured, but not usable" rather than "off".
 * @param {Request} req The request.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const getEgress = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)

  if (!uid) {
    res.status(401).json({ error: "unauthorized", code: "unauthorized" })
    return
  }

  try {
    res.status(200).json(await readEgressSettings(uid))
  } catch (error) {
    console.error("egress: read failed:", errorLabel(error))
    res.status(500).json({ error: "internal", code: "internal" })
  }
}

/**
 * `PUT /api/egress` -- replace the caller's exits, or clear them.
 *
 * The body is `{mode: "byo", proxies: ["http://user:pass@host:port"]}` or
 * `{mode: "platform"}` to go back to the platform pool. `mode` is required
 * rather than inferred, because either guess is wrong for somebody: reading an
 * absent mode as "set" lets a typo clear a working pool, and reading it as
 * "clear" silently drops the caller onto our addresses.
 *
 * A cleared pool purges the secret, so "I removed my proxy" is true rather than
 * merely unevaluated.
 * @param {Request} req The request carrying the write.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const setEgress = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)

  if (!uid) {
    res.status(401).json({ error: "unauthorized", code: "unauthorized" })
    return
  }

  const validation = validateEgressInput(req.body)

  if (!validation.ok) {
    // Index and fixed reason only -- the entry carries a credential.
    res.status(400).json({
      error: "bad_request",
      code: "bad_request",
      index: validation.index,
      reason: validation.reason,
    })
    return
  }

  try {
    res.status(200).json(await writeEgressSettings(uid, validation.write))
  } catch (error) {
    console.error("egress: write failed:", errorLabel(error))
    res.status(500).json({ error: "internal", code: "internal" })
  }
}
