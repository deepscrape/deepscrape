/* eslint-disable object-curly-spacing */
/**
 * The monitor CRUD surface — `/monitor/*`.
 *
 * Why these are free-tier routes
 * -----------------------------
 * They carry `resolveAccess` (not `requirePaidAccess`) on both hosts, for the
 * same reason `/serp` does: a monitor is one bounded, infrequent read of one
 * page — the same capability class as a search — and `requirePaidAccess` is the
 * only place `req.accessMode` is ever populated, so gating on it would 402 a
 * free caller before the entitlement was resolved at all. What bounds a free
 * account is not a plan check but `MONITOR_MAX_PER_USER`, enforced on create,
 * because the thing being protected is the shared worker pool rather than
 * revenue.
 *
 * Scoping, which is the part that would be a breach if it were wrong
 * ----------------------------------------------------------------
 * Every route here takes the caller's uid from the VERIFIED token
 * (`req.user.uid`, set by `isJwtAuth` on both hosts) and passes it to the
 * store, and the store answers only for a monitor whose stored `uid` matches.
 * The monitor id in the request body is therefore an ADDRESS, never a
 * credential: a foreign id answers 404, exactly like one that does not exist,
 * so this surface cannot be used to discover whether another account's monitor
 * exists. Nothing here trusts a uid from the body.
 */
import { Request, Response } from "express"

import { bodyOf, uidOf } from "./request-helpers"
import {
  MONITOR_MAX_PER_USER,
  buildMonitorFields,
  buildMonitorPatch,
  parseChecksRequest,
} from "../domain/monitors.domain"
import {
  countMonitors,
  createMonitor,
  deleteMonitor,
  listChecks,
  listMonitors,
  readMonitor,
  updateMonitor,
} from "../infrastructure/monitor.store"

/** The single internal-error answer, so the five routes cannot disagree.
 * @param {Response} res The response.
 * @param {string} what What failed, for the log.
 * @param {unknown} error The thrown value.
 */
const internal = (res: Response, what: string, error: unknown): void => {
  console.error(`monitor: ${what} failed:`, error)
  res.status(500).json({ error: "internal", code: "internal" })
}

/**
 * `POST /monitor/create` — start watching a URL.
 *
 * The per-account cap is checked here rather than trusted to the client, and
 * the count is read immediately before the write — a race that lets a
 * determined caller exceed it by one is a better trade than a transaction on a
 * path that runs once per monitor.
 * @param {Request} req
 * @param {Response} res
 */
export const monitorCreate = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    res.status(401).json({ error: "unauthorized", code: "unauthorized" })
    return
  }

  try {
    const owned = await countMonitors(uid)
    if (owned >= MONITOR_MAX_PER_USER) {
      res.status(400).json({
        error:
          `You can watch ${MONITOR_MAX_PER_USER} pages at a time; ` +
          "delete one first",
      })
      return
    }

    const built = buildMonitorFields(uid, bodyOf(req), Date.now())
    if (!built.ok) {
      res.status(400).json({ error: built.error })
      return
    }

    const monitor = await createMonitor(uid, built.monitor)
    res.status(201).json({ status: "ok", monitor })
  } catch (error) {
    internal(res, "create", error)
  }
}

/**
 * `GET /monitor/list` — every monitor this account owns.
 * @param {Request} req
 * @param {Response} res
 */
export const monitorList = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    res.status(401).json({ error: "unauthorized", code: "unauthorized" })
    return
  }

  try {
    const monitors = await listMonitors(uid)
    res.status(200).json({ status: "ok", monitors, total: monitors.length })
  } catch (error) {
    internal(res, "list", error)
  }
}

/**
 * `POST /monitor/update` — patch one monitor.
 *
 * The id is validated by the store against the caller's own documents; a
 * monitor that is not theirs is reported as missing.
 * @param {Request} req
 * @param {Response} res
 */
export const monitorUpdate = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    res.status(401).json({ error: "unauthorized", code: "unauthorized" })
    return
  }

  const body = bodyOf(req)
  const id = typeof body["id"] === "string" ? body["id"].trim() : ""

  try {
    const current = await readMonitor(uid, id)
    if (!current) {
      res.status(404).json({ error: "No such monitor" })
      return
    }

    const patched = buildMonitorPatch(current, body, Date.now())
    if (!patched.ok) {
      res.status(400).json({ error: patched.error })
      return
    }

    const monitor = await updateMonitor(uid, id, patched.patch)
    if (!monitor) {
      // Deleted between the read above and the write.
      res.status(404).json({ error: "No such monitor" })
      return
    }

    res.status(200).json({ status: "ok", monitor })
  } catch (error) {
    internal(res, "update", error)
  }
}

/**
 * `POST /monitor/delete` — stop watching, and drop the history.
 * @param {Request} req
 * @param {Response} res
 */
export const monitorDelete = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    res.status(401).json({ error: "unauthorized", code: "unauthorized" })
    return
  }

  const body = bodyOf(req)
  const id = typeof body["id"] === "string" ? body["id"].trim() : ""

  try {
    const deleted = await deleteMonitor(uid, id)
    if (!deleted) {
      res.status(404).json({ error: "No such monitor" })
      return
    }

    res.status(200).json({ status: "ok", id })
  } catch (error) {
    internal(res, "delete", error)
  }
}

/**
 * `GET /monitor/checks` — the newest check rows for one monitor.
 *
 * Registered as a GET because it reads, and it therefore takes `id` and `limit`
 * from the query string; the body is accepted too, so a client that sends the
 * documented object as JSON is not punished for it.
 * @param {Request} req
 * @param {Response} res
 */
export const monitorChecks = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    res.status(401).json({ error: "unauthorized", code: "unauthorized" })
    return
  }

  const parsed = parseChecksRequest(req.query, req.body)
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error })
    return
  }

  try {
    const checks = await listChecks(uid, parsed.id, parsed.limit)
    if (!checks) {
      res.status(404).json({ error: "No such monitor" })
      return
    }

    res.status(200).json({
      status: "ok",
      id: parsed.id,
      checks,
      limit: parsed.limit,
    })
  } catch (error) {
    internal(res, "checks", error)
  }
}
