/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * `POST /api/browser/vault` — the durable half of a profile.
 *
 * What this route is, and what it is not
 * --------------------------------------
 * A stored profile is a cookie jar that outlives the machine it was captured on.
 * The machine side is webrain's: `cookies` reads a jar out of a browser and
 * `setcookies` writes one back. This route is the OTHER half — the part that
 * makes the jar survive at all, because a session machine has no volume and Fly
 * resets a stopped machine's root filesystem, so a jar that only ever lived in
 * the browser is gone at the first idle reap.
 *
 * It therefore stores what the CALLER hands it, opaquely, and hands it back. It
 * never speaks to a worker: the caller already has the jar (that is what the
 * `cookies` op answers with) and will push it back with `setcookies`. Keeping the
 * worker out of this route is what keeps every payload shape in the platform's
 * own contract rather than depending on a tool reply this repo cannot verify.
 *
 * Four ops, and only one of them is destructive
 * --------------------------------------------
 *   store  — seal a payload and index it
 *   load   — the payload back
 *   list   — names only, which is all the index holds
 *   forget — delete the payload, then the index row
 *
 * `forget` removes the BLOB FIRST and the index row second, deliberately: if the
 * second step fails the caller sees an entry that answers 404, whereas doing it
 * the other way round hides a live credential with nothing left pointing at it.
 */
import { Request, Response } from "express"
import {
  VAULT_MAX_ENTRIES,
  isSafeVaultName,
} from "../domain/vault-entry.domain"
import { VAULT_PAYLOAD_MAX_BYTES } from "../domain/vault-payload.domain"
import {
  deleteVaultEntry,
  listVaultEntries,
  recordVaultEntry,
} from "../infrastructure/vault.store"
import {
  dropVaultPayload,
  getVaultPayload,
  putVaultPayload,
  vaultStorageAvailable,
} from "../infrastructure/vault-payload"

/** The ops this route understands. */
export type VaultPlatformOp = "store" | "load" | "list" | "forget"

/** The same four names in the order an error message should list them. */
export const VAULT_PLATFORM_OPS: readonly VaultPlatformOp[] = [
  "store",
  "load",
  "list",
  "forget",
]

/**
 * Whether a value names one of those ops.
 *
 * The array above is the whole list, so this cannot drift from it. The widening
 * cast is confined to this line because `Array.includes` on a union array types
 * its argument as the union, and the question being asked is precisely whether a
 * plain string is on it.
 * @param {unknown} value The candidate.
 * @return {boolean} True when the value is a platform op.
 */
const isVaultPlatformOp = (value: unknown): value is VaultPlatformOp =>
  typeof value === "string" &&
  (VAULT_PLATFORM_OPS as readonly string[]).includes(value)

/** One parsed request: the ops, or why the body was refused. */
export type VaultRequest =
  | { ok: false, status: number; error: string }
  | { ok: true; op: "list" }
  | {
    ok: true
    op: "store" | "load" | "forget"
    service: string
    profile: string
    payload?: unknown
  }

/**
 * The request body as a record, empty when it is not one.
 * @param {unknown} body The parsed body.
 * @return {Record<string, unknown>} The body as a record.
 */
const recordOf = (body: unknown): Record<string, unknown> =>
  body && typeof body === "object" ? body as Record<string, unknown> : {}

/**
 * The request, or a refusal that says which field is wrong.
 *
 * Pure, so every branch is testable without a bucket, a key or a request. The two
 * names go through `isSafeVaultName` because they address an OBJECT as well as a
 * document, and the payload is checked against the size limit HERE so an
 * oversized body is a 400 rather than a 500 from the sealer.
 * @param {unknown} body The parsed request body.
 * @return {VaultRequest} The request, or a refusal.
 */
export const vaultRequestFrom = (body: unknown): VaultRequest => {
  const source = recordOf(body)
  const named = typeof source["op"] === "string" ?
    source["op"].trim().toLowerCase() :
    ""

  if (!named) {
    return { ok: false, status: 400, error: "Missing vault op" }
  }
  if (!isVaultPlatformOp(named)) {
    return {
      ok: false,
      status: 400,
      error:
        `Unknown vault op "${named}"; expected one of ` +
        VAULT_PLATFORM_OPS.join(", "),
    }
  }

  const op = named

  if (op === "list") {
    return { ok: true, op: "list" }
  }

  const service = source["service"]
  const profile = source["profile"]
  if (!isSafeVaultName(service) || !isSafeVaultName(profile)) {
    return {
      ok: false,
      status: 400,
      error:
        `op=${op} needs a service and a profile of letters, digits, dot, ` +
        "dash and underscore",
    }
  }

  if (op !== "store") {
    return { ok: true, op, service, profile }
  }

  const payload = source["payload"]
  if (payload === undefined || payload === null) {
    return { ok: false, status: 400, error: "op=store needs a payload" }
  }

  const size = Buffer.byteLength(JSON.stringify(payload), "utf8")
  if (size > VAULT_PAYLOAD_MAX_BYTES) {
    return {
      ok: false,
      status: 400,
      error:
        `op=store payload is ${size} bytes, over the ` +
        `${VAULT_PAYLOAD_MAX_BYTES}-byte limit`,
    }
  }

  return { ok: true, op, service, profile, payload }
}

/** The caller's uid, or undefined when the token carried none.
 * @param {Request} req The request.
 * @return {string | undefined} The uid.
 */
const uidOf = (req: Request): string | undefined => {
  const uid = req.user?.uid
  return typeof uid === "string" && uid.length > 0 ? uid : undefined
}

/** The one error shape, so no op can answer with a bare status.
 * @param {Response} res The response.
 * @param {number} status The HTTP status.
 * @param {string} error The message.
 * @return {void} Nothing.
 */
const fail = (res: Response, status: number, error: string): void => {
  res.status(status).json({ error })
}

/**
 * `POST /api/browser/vault` — store, read, list and forget one caller's entries.
 *
 * The uid comes from the VERIFIED token and every store call is scoped by it, so
 * a caller cannot name another account's entry: the object key and the index row
 * are both derived from the uid, and neither is an argument.
 * @param {Request} req The request.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response has been written.
 */
export const browserVault = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    fail(res, 401, "Unauthorized: Missing or invalid token")
    return
  }

  const parsed = vaultRequestFrom(req.body)
  if (!parsed.ok) {
    fail(res, parsed.status, parsed.error)
    return
  }

  // One check ahead of any work, because an unconfigured deployment must not
  // answer "no such entry" -- that would read as "your saved profile is gone".
  if (!vaultStorageAvailable()) {
    fail(
      res,
      503,
      "The vault is not configured on this deployment (VAULT_DATA_KEY and a " +
      "platform bucket are required)",
    )
    return
  }

  try {
    if (parsed.op === "list") {
      res.json({ entries: await listVaultEntries(uid) })
      return
    }

    if (parsed.op === "load") {
      const payload = await getVaultPayload(uid, parsed.service, parsed.profile)
      if (payload === undefined) {
        fail(res, 404, "No such vault entry")
        return
      }
      res.json({
        entry: { service: parsed.service, profile: parsed.profile },
        payload,
      })
      return
    }

    if (parsed.op === "store") {
      const entries = await listVaultEntries(uid)
      const known = entries.some(
        (entry) =>
          entry.service === parsed.service && entry.profile === parsed.profile,
      )
      if (!known && entries.length >= VAULT_MAX_ENTRIES) {
        fail(
          res,
          409,
          `An account may hold ${VAULT_MAX_ENTRIES} vault entries`,
        )
        return
      }

      // The BLOB first, then the index: a crash between the two leaves an object
      // nothing points at, which the purge still sweeps and a re-save
      // overwrites. The other order leaves a listed entry with no payload.
      const bytes = await putVaultPayload(
        uid,
        parsed.service,
        parsed.profile,
        parsed.payload,
      )
      await recordVaultEntry(uid, {
        service: parsed.service,
        profile: parsed.profile,
      })
      res.json({
        entry: { service: parsed.service, profile: parsed.profile },
        bytes,
      })
      return
    }

    // `forget`. The blob goes first for the reason this file's header gives.
    await dropVaultPayload(uid, parsed.service, parsed.profile)
    const removed = await deleteVaultEntry(uid, parsed.service, parsed.profile)
    if (!removed) {
      fail(res, 404, "No such vault entry")
      return
    }
    res.json({
      removed: { service: parsed.service, profile: parsed.profile },
    })
  } catch (error) {
    // Whatever reached here is ours, not the caller's: a missing object is
    // `undefined` rather than a throw, and every other failure in this path is a
    // key, a bucket or a decryption that a 5xx must not explain in detail.
    console.error(
      "vault: op failed:",
      error instanceof Error ? error.message : typeof error,
    )
    fail(res, 500, "The vault could not complete that request")
  }
}
