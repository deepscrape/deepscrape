/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * `GET /api/admin/sessions` — every live browser session, platform-wide.
 *
 * A separate module from `machine-fleet.ts` even though the two routes are
 * siblings, because the two describe different objects with different bounds:
 * a machine is a Fly resource, a session is a billing record, and the fields an
 * operator reads differ. They share only the gate and the `truncated` contract.
 *
 * Why the gate is `platform`
 * -------------------------
 * Same answer as the fleet route, and it is not a copy of it by habit. Listing
 * every tenant's live sessions is a platform-scope act, and `crawl.execute` —
 * which every paid customer holds — would hand every paying tenant a live view
 * of every other tenant's browser activity. `platform` is granted to NO role in
 * `POLICIES` and is admitted only by the `isPlatformAdmin` short-circuit in
 * `canPerform`, which is exactly the scope this needs.
 *
 * Why there is no `uid` parameter
 * ------------------------------
 * The request carries no tenant. The scope is the whole platform and the route
 * in `bff/api.ts` decides who may ask. This handler reads nothing from the body
 * or the query, so there is no input here to validate into an escalation.
 *
 * The response is shaped in the STORE, not here
 * --------------------------------------------
 * `AdminSession` has no field a credential could occupy, because a session
 * record carries `cdpSecretPath`. This module only adds the envelope, so it
 * cannot widen the projection by accident.
 *
 * READ-ONLY, and that is a decision rather than a missing feature
 * -------------------------------------------------------------
 * The roadmap asks for "idle time, minutes billed, one-click reclaim". This
 * ships the first two. Reclaim is NOT a UI omission: pulling another tenant's
 * session forward means moving the idle deadline the Go reaper reads, which
 * suspends a customer's live, still-billing machine — a destructive action
 * against someone else's money, performed by a third party. The machine fleet
 * view is read-only for the same class of reason and its actions needed
 * sign-off. Until that sign-off exists, an operator gets a row they can READ
 * rather than a button that spends someone else's credits.
 */
import { Request, Response } from "express"
import {listAdminSessions} from "../infrastructure/browser-session.store"

/**
 * One failure message, so the console and the log do not disagree.
 * @param {Response} res The response.
 * @param {string} what The operation that failed.
 * @param {unknown} error The failure.
 * @return {void} Nothing.
 */
const internal = (res: Response, what: string, error: unknown): void => {
  console.error(`[session-fleet] ${what} failed`, error)
  res.status(500).json({status: "error", code: "sessions_unavailable"})
}

/**
 * `GET /api/admin/sessions` — every live session.
 *
 * A 500 rather than an empty list when the read fails, for the reason the fleet
 * route states and it applies here with more force: a `FAILED_PRECONDITION` from
 * an undeployed collection-group index and a genuinely idle platform produce the
 * same empty table, and reporting the first as the second tells an operator that
 * nobody is running browsers while customers are being billed for them.
 * @param {Request} _req The request. Unused: the scope is the whole platform.
 * @param {Response} res The response.
 * @return {Promise<void>} Nothing.
 */
export const sessionFleetList = async (
  _req: Request,
  res: Response
): Promise<void> => {
  try {
    const reply = await listAdminSessions()
    res.status(200).json({
      status: "ok",
      sessions: reply.sessions,
      truncated: reply.truncated,
    })
  } catch (error) {
    internal(res, "list", error)
  }
}
