/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * Funding an organization's credit wallet -- `/api/orgs/:orgId/credits/transfer`.
 *
 * Why an organization needs a wallet at all
 * -----------------------------------------
 * A workspace is a billing boundary: the org pays, the member acts. Until it can
 * HOLD credits, "the org pays" is only true for card charges, and every metered
 * call has to be taken from a person. This route is the one way credits move
 * from a member into the org, and it creates no money: every credit in the org's
 * ledger has a matching debit in a person's.
 *
 * Why the caller's OWN wallet is the only source
 * ---------------------------------------------
 * A grant from nowhere would be money invented by an endpoint. A card purchase
 * into an org needs a Stripe customer per org, which is a separate decision and
 * is not made here.
 *
 * The bucket is `purchased`, and that is a rule rather than a default: an
 * `included` credit is granted to a PERSON by their plan and expires with it, so
 * moving one into an org would let it outlive the entitlement that created it.
 *
 * `req.params.orgId` is the org the guard authorised, because
 * `getOrgIdFromRequest` reads the path parameter FIRST -- so the org this handler
 * credits is the same one `perm('organization', 'manage')` approved. Reading the
 * header here instead would credit a different org than the one checked.
 */
import {Request, Response} from "express"

import {transferOrganizationCredits} from "../app/billing-credits"
import {bodyOf, errorLabel, uidOf} from "./request-helpers"

/**
 * Write a machine-readable refusal.
 * @param {Response} res The response.
 * @param {number} status The HTTP status.
 * @param {string} code The machine-readable code.
 * @return {void} Writes the response.
 */
const fail = (res: Response, status: number, code: string): void => {
  res.status(status).json({error: code, code})
}

/**
 * `POST /api/orgs/:orgId/credits/transfer` -- move credits either way.
 *
 * Requires `organization.manage`, which the POLICIES table grants to the OWNER
 * alone (an admin holds `read` and `invite`, not `manage`). Both directions are
 * that capability: funding a shared wallet, and emptying it again so the org can
 * be deleted -- `deleteOrganization` refuses while the wallet holds credits, and
 * without this direction the only way out of that refusal is to spend them.
 * @param {Request} req The request carrying `{amount, direction?, idempotencyKey?}`.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const orgCreditTransfer = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    fail(res, 401, "unauthorized")
    return
  }

  const orgId =
    typeof req.params?.["orgId"] === "string" ?
      req.params["orgId"].trim() :
      ""
  if (!orgId) {
    fail(res, 400, "missing_org")
    return
  }

  const body = bodyOf(req)
  const amount = Number(body["amount"])
  // An unreadable direction moves credits the way this route always has, rather
  // than the way that empties a wallet.
  const direction = body["direction"] === "fromOrg" ? "fromOrg" : "toOrg"

  // A client key is honoured when given; otherwise a one-minute bucket makes an
  // accidental double-click a replay instead of a second debit. The direction is
  // IN the key: a fund and a withdraw of the same amount must not collide.
  const suppliedKey =
    typeof body["idempotencyKey"] === "string" ?
      body["idempotencyKey"].trim() :
      ""
  const idempotencyKey =
    suppliedKey ||
    `org-${direction === "toOrg" ? "fund" : "withdraw"}:${uid}:${orgId}:` +
      `${Math.floor(amount) || 0}:${Math.floor(Date.now() / 60_000)}`

  try {
    const result = await transferOrganizationCredits({
      uid,
      orgId,
      amount,
      bucket: "purchased",
      idempotencyKey,
      direction,
    })

    res.status(200).json(result)
  } catch (error) {
    const message = errorLabel(error)
    // A refusal is the customer's balance, not a fault: 402 states the remedy
    // (top up) where a 500 would read as "try again later".
    const refused = message.includes("Credit transfer refused")
    if (refused) {
      res.status(402).json({
        error: "transfer_refused",
        reason: message.includes("insufficient") ?
          "insufficient_credits" :
          "amount_not_positive",
      })
      return
    }

    console.error("org credits: transfer failed:", message)
    fail(res, 500, "internal")
  }
}
