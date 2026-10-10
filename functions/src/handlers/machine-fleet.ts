/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * `GET /api/admin/machines` — the platform-wide machine fleet.
 *
 * Why this is a new route and not an existing one
 * ----------------------------------------------
 * Every other machine route is PER-MACHINE (`/machine/:id`, plus start, suspend,
 * stop and destroy) and is gated `paid + perm('machine', ...)`, which is
 * TENANT-scoped. There is no list route anywhere, in either surface, so there was
 * nothing to extend. Note the fleet view's ACTIONS still use those tenant routes:
 * arachnefly's `MachineOwnershipMiddleware` admits only the machine's owner, and
 * it has no admin bypass, so a platform admin can list another tenant's machine
 * and cannot act on it. That is deliberate and it is not a bug to route around
 * here; see roadmap `05` Part D.
 *
 * Why the gate is `platform` and not `machine`
 * -------------------------------------------
 * Reading every tenant's machines is a platform-scope act. `machine.read` would
 * put a cross-tenant listing behind a permission every paid customer holds, which
 * is the class of bug Phase 0 closed. `platform` is granted to NO role in
 * `POLICIES` and is admitted only by the `isPlatformAdmin` short-circuit in
 * `canPerform`, which is exactly the scope this needs.
 *
 * Why there is no `uid` parameter
 * ------------------------------
 * The request has no tenant in it. The scope is the whole platform, and the route
 * in `bff/api.ts` is what decides who may ask; this handler answers the question
 * it is given. It reads nothing from the body or the query, so there is no input
 * here to validate into an escalation.
 *
 * The response is shaped in the STORE, not here
 * --------------------------------------------
 * `FleetMachine` has no field a credential could occupy, because a machine
 * document carries `config.env` and that includes `WEBRAIN_HTTP_TOKEN`. This
 * module only adds the envelope, so it cannot widen the projection by accident.
 */
import { Request, Response } from "express"
import {listFleetMachines, listMachinesForUser} from "../infrastructure/machine.store"

/**
 * One failure message, so the console and the log do not disagree.
 * @param {Response} res The response.
 * @param {string} what The operation that failed.
 * @param {unknown} error The failure.
 * @return {void} Nothing.
 */
const internal = (res: Response, what: string, error: unknown): void => {
  console.error(`[machine-fleet] ${what} failed`, error)
  res.status(500).json({status: "error", code: "fleet_unavailable"})
}

/**
 * `GET /api/admin/machines` — every machine, newest first.
 *
 * A 500 rather than an empty list when the read fails. An empty fleet and an
 * unreadable fleet look identical on screen, and the remedy for the first is
 * "you have no machines" while the remedy for the second is "fix the index".
 * Reporting the second as the first is how an operator concludes the platform is
 * idle when it is actually on fire.
 * @param {Request} _req The request. Unused: the scope is the whole platform.
 * @param {Response} res The response.
 * @return {Promise<void>} Nothing.
 */
export const machineFleetList = async (
  _req: Request,
  res: Response
): Promise<void> => {
  try {
    const reply = await listFleetMachines()
    res.status(200).json({
      status: "ok",
      machines: reply.machines,
      truncated: reply.truncated,
    })
  } catch (error) {
    internal(res, "list", error)
  }
}

/**
 * The caller's own uid, or undefined when the token carried none.
 * @param {Request} req The request.
 * @return {string | undefined} The verified uid.
 */
const uidOf = (req: Request): string | undefined => {
  const uid = req.user?.uid
  return typeof uid === "string" && uid.length ? uid : undefined
}

/**
 * `GET /api/machines` - the caller's own machines, each marked with what it is for.
 *
 * Why this route exists next to `/api/admin/machines`
 * ------------------------------------------------
 * They answer different questions and take different gates. This one is
 * TENANT-scoped: the uid comes from the verified token and the store reads only
 * that caller's subcollection, so the route cannot be widened by an input. The
 * admin one is platform-scoped and gated `platform`, which no role holds.
 *
 * Why `kind` is the point of the response
 * -------------------------------------
 * The same subcollection holds two different things: containers the caller
 * deployed, and the machines their browser sessions own. They look alike in
 * Firestore and are NOT alike to act on. A container is driven by the machine
 * routes; a session's machine is released by the session's own close route, and
 * destroying it directly leaves a session record still billing for a machine that
 * no longer exists. So the client is TOLD which is which, from a join against the
 * session records, instead of inferring it from the `bs-` name prefix that
 * nothing enforces.
 *
 * A 401 rather than an empty list when there is no uid. `guard` prepends the jwt
 * middleware so this should be unreachable, and if it is ever reachable the safe
 * answer is a refusal, not "you have no machines".
 * @param {Request} req The request.
 * @param {Response} res The response.
 * @return {Promise<void>} Nothing.
 */
export const machineListMine = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    res.status(401).json({status: "error", code: "invalid_token"})
    return
  }

  try {
    const machines = await listMachinesForUser(uid)
    res.status(200).json({status: "ok", machines: machines})
  } catch (error) {
    internal(res, "list mine", error)
  }
}
