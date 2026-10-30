/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The artifact storage surface -- `/api/storage/*`.
 *
 * One implementation, two hosts: `infrastructure/syncaiapi.ts` registers these
 * on the Express router and `bff/api.ts` registers the same paths through the
 * bridge, exactly as the org and monitor routes do. Neither host re-decides
 * anything, so there is one answer to "where does this object go?".
 *
 * The rule, and where it is enforced
 * ---------------------------------
 * A shared-cache entry is served to every caller who asks for its URL, so it
 * may only hold the result of a fetch that carried NO caller credential. That
 * decision is `decideStorageScope` in `domain/storage-scope.domain.ts` and it
 * is made HERE, once, before any store is touched. The scope is then returned
 * in the response, so a caller can see which tier their bytes landed in.
 *
 * This handler never replays a caller credential into the outbound fetch: the
 * fetch it performs is always anonymous, and the `credential` field exists only
 * to describe the caller's own fetch context. That means the descriptor can
 * only ever DEMOTE an object to the user tier -- it cannot be used to reach a
 * credential-protected URL, and it cannot turn a credentialed fetch into a
 * shared one. The asymmetry is the point.
 *
 * What a presigned URL is
 * -----------------------
 * A presigned URL is a bearer credential in a query string, so it is minted
 * only for a key the caller may read (`isReadableObjectKey`), for a short TTL,
 * and for nothing else. A key that names another caller's object answers 404,
 * not 403, so the response cannot be used to discover that the object exists.
 */
import {Request, Response} from "express"

import { bodyOf, errorLabel, uidOf } from "./request-helpers"
import {
  LIST_LIMIT,
  PRESIGN_TTL_SECONDS,
  SHARED_KEY_PREFIX,
  decideStorageScope,
  isExposableSharedUrl,
  isReadableObjectKey,
  isSharedObjectKey,
  sanitizeFilename,
  userObjectKeyPrefix,
  userPayloadKey,
} from "../domain/storage-scope.domain"
import {
  toPublicSettings,
  validateStorageSettingsInput,
} from "../domain/storage-settings.domain"
import {targetUrlFrom} from "../domain/url-guard.domain"
import type {StoredBlob} from "../infrastructure/blob-store.port"
import {getPlatformBlobStore} from "../infrastructure/platform-blob-store"
import {
  readStorageSettings,
  resolveBlobStore,
  writeStorageSettings,
} from "../infrastructure/storage-settings.store"

/** Object metadata keys, so a `put` and a `list` cannot disagree on spelling. */
const META_URL = "url"
const META_SCOPE = "scope"
const META_CREATED_AT = "createdAt"
const META_FILENAME = "filename"

/** The ceiling on one download, enforced while reading, not after. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024

/** How long one hop of a fetch may take. */
const FETCH_TIMEOUT_MS = 20000

/** Redirect hops followed. Each one is re-validated before it is requested. */
const MAX_REDIRECTS = 5

/** How long a stored artifact may sit in a private cache. */
const ARTIFACT_CACHE_SECONDS = 3600

/** The redirect statuses that name a new location. */
const REDIRECT_STATUS = [301, 302, 303, 307, 308]

/** The one error shape, so the five routes cannot disagree.
 * @param {Response} res The response.
 * @param {number} status The HTTP status.
 * @param {string} code The machine-readable code.
 * @return {void} Writes the response.
 */
const fail = (res: Response, status: number, code: string): void => {
  res.status(status).json({error: code, code})
}

/** One object as the API reports it.
 * @param {StoredBlob} blob The stored record.
 * @return {Record<string, unknown>} The public shape.
 */
const toPublicObject = (blob: StoredBlob): Record<string, unknown> => ({
  key: blob.key,
  url: blob.custom[META_URL] ?? "",
  scope: blob.custom[META_SCOPE] === "shared" ? "shared" : "user",
  bytes: blob.bytes,
  createdAt: blob.custom[META_CREATED_AT] ?? "",
})

/**
 * The global `fetch` response, named once.
 *
 * Deliberately not `Response`: that identifier is Express's response object in
 * this file, so annotating the upstream type with it would let a wrong-shaped
 * call look correct to the compiler -- reading `body` off the wrong object is
 * exactly the mistake this alias prevents.
 */
type FetchResponse = Awaited<ReturnType<typeof fetch>>

/** The outcome of one download. */
type FetchResult =
  | {ok: true; body: Buffer; contentType: string}
  | {ok: false; reason: string}

/**
 * Read a response body, refusing once it exceeds `limit`.
 *
 * The cap is enforced WHILE reading rather than by measuring afterwards: a
 * `content-length` header is a claim, and a server that lies about it would
 * otherwise be able to exhaust the instance's memory before the check ran.
 * @param {FetchResponse} response The upstream response.
 * @param {number} limit The maximum number of bytes to accept.
 * @return {Promise<Buffer | null>} The bytes, or null when over the limit.
 */
const readCapped = async (
  response: FetchResponse,
  limit: number
): Promise<Buffer | null> => {
  const stream = response.body

  if (!stream) {
    const buffer = Buffer.from(await response.arrayBuffer())
    return buffer.length <= limit ? buffer : null
  }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const {done, value} = await reader.read()
    if (done) {
      break
    }

    if (!value) {
      continue
    }

    total += value.length
    if (total > limit) {
      await reader.cancel()
      return null
    }

    chunks.push(value)
  }

  return Buffer.concat(chunks)
}

/**
 * Fetch one URL, anonymously, with every redirect hop re-validated.
 *
 * `redirect: "manual"` and a re-check of each `Location` against
 * `targetUrlFrom` closes the half of the SSRF guard that `url-guard.domain.ts`
 * documents as unfixable at its own layer: the guard runs before the request,
 * so a target that redirects into private space would defeat it. This client
 * makes the connection, so this client is where the per-hop policy belongs.
 * @param {string} url The validated target URL.
 * @return {Promise<FetchResult>} The bytes and media type, or a reason.
 */
export const fetchArtifact = async (url: string): Promise<FetchResult> => {
  let current = url

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: FetchResponse

    try {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch {
      return {ok: false, reason: "fetch_failed"}
    }

    if (REDIRECT_STATUS.includes(response.status)) {
      const location = response.headers.get("location")
      const next = location ? targetUrlFrom(`${new URL(location, current)}`) : undefined

      if (!next) {
        return {ok: false, reason: "unsafe_redirect"}
      }

      current = next
      continue
    }

    if (!response.ok) {
      return {ok: false, reason: "fetch_failed"}
    }

    const body = await readCapped(response, MAX_ARTIFACT_BYTES)
    if (!body) {
      return {ok: false, reason: "too_large"}
    }

    const contentType = response.headers.get("content-type") ??
      "application/octet-stream"

    return {ok: true, body, contentType}
  }

  return {ok: false, reason: "too_many_redirects"}
}

/**
 * `POST /api/storage/save` -- fetch a URL once and keep the artifact.
 *
 * The scope is decided before the store is resolved, so a credentialed fetch
 * can never reach the shared bucket even if the store lookup is later changed.
 * @param {Request} req The request carrying `{url, filename?, credential?}`.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const storageSave = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    fail(res, 401, "unauthorized")
    return
  }

  const body = bodyOf(req)
  const url = targetUrlFrom(body["url"])
  if (!url) {
    fail(res, 400, "invalid_url")
    return
  }

  const filename = sanitizeFilename(body["filename"])
  const decision = decideStorageScope(uid, url, body["credential"])

  // Visible on purpose: which tier an artifact landed in is the answer to the
  // only question this route can get wrong silently.
  console.info("[storage-scope]", JSON.stringify({
    uid,
    scope: decision.scope,
    reason: decision.reason,
  }))

  try {
    const store = await resolveBlobStore(uid, decision.scope)
    if (!store) {
      fail(res, 501, "byob_unavailable")
      return
    }

    const existing = await store.stat(decision.key)
    if (existing) {
      res.status(200).json({
        key: decision.key,
        scope: decision.scope,
        bytes: existing.bytes,
        cached: true,
      })
      return
    }

    const fetched = await fetchArtifact(url)
    if (!fetched.ok) {
      res.status(502).json({error: fetched.reason, code: fetched.reason})
      return
    }

    const custom: Record<string, string> = {
      [META_URL]: url,
      [META_SCOPE]: decision.scope,
      [META_CREATED_AT]: new Date().toISOString(),
    }

    if (filename) {
      custom[META_FILENAME] = filename
    }

    await store.put(decision.key, fetched.body, {
      contentType: fetched.contentType,
      cacheSeconds: ARTIFACT_CACHE_SECONDS,
      custom,
    })

    res.status(200).json({
      key: decision.key,
      scope: decision.scope,
      bytes: fetched.body.length,
      cached: false,
    })
  } catch (error) {
    console.error("storage: save failed:", errorLabel(error))
    fail(res, 500, "internal")
  }
}

/**
 * `POST /api/storage/payload` -- keep bytes the caller already holds.
 *
 * Why this exists
 * ---------------
 * `storageSave` fetches a URL, so it can only file something the platform can
 * reach again. A playground tool result is the opposite: the worker returned it
 * to us, `output` is a bare filename on the worker's own disk, and there is no
 * address to fetch. So a run's result could be read in the UI and then lost --
 * which is what "storage of tool payloads" was.
 *
 * Why it is user-scope only
 * -------------------------
 * The shared tier is keyed by URL, and a payload has no url to key it by. It is
 * therefore filed in the caller's own namespace, which is also what makes it
 * impossible for one tenant's result to be served to another: the key is a
 * digest under `userObjectKeyPrefix(uid)`.
 *
 * The body is validated before the store is touched, and the size ceiling is
 * the same one a downloaded artifact has, so one route cannot become the way
 * around the other's limit.
 * @param {Request} req The request carrying `{content, filename?, contentType?}`.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const storageSavePayload = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    fail(res, 401, "unauthorized")
    return
  }

  const body = bodyOf(req)
  const content = typeof body["content"] === "string" ? body["content"] : null
  if (content === null) {
    fail(res, 400, "invalid_content")
    return
  }

  const bytes = Buffer.from(content, "utf8")
  if (bytes.length === 0) {
    fail(res, 400, "empty_content")
    return
  }

  if (bytes.length > MAX_ARTIFACT_BYTES) {
    fail(res, 413, "too_large")
    return
  }

  const name = sanitizeFilename(body["filename"]) ?? "result.json"
  const declared = typeof body["contentType"] === "string" ?
    body["contentType"].trim() : ""
  // Derived from the NAME rather than taken from the body when the caller says
  // nothing: this value reaches a `Content-Disposition` header on the presigned
  // path, and the name is the only part of the request that has already been
  // sanitized.
  const contentType = declared ||
    (name.toLowerCase().endsWith(".json") ?
      "application/json" :
      "text/plain; charset=utf-8")

  const key = userPayloadKey(uid, name)

  try {
    const store = await resolveBlobStore(uid, "user")
    if (!store) {
      fail(res, 501, "byob_unavailable")
      return
    }

    await store.put(key, bytes, {
      contentType,
      cacheSeconds: ARTIFACT_CACHE_SECONDS,
      custom: {
        [META_SCOPE]: "user",
        [META_CREATED_AT]: new Date().toISOString(),
        [META_FILENAME]: name,
      },
    })

    res.status(200).json({key, scope: "user", bytes: bytes.length})
  } catch (error) {
    console.error("storage: payload save failed:", errorLabel(error))
    fail(res, 500, "internal")
  }
}

/**
 * `GET /api/storage/list` -- the caller's own objects, plus the shared cache.
 *
 * A caller never sees another caller's objects: the user-tier read is scoped by
 * a prefix derived from the VERIFIED uid, and the only other tier listed is the
 * shared one. A shared entry belongs to nobody, so its `url` metadata is
 * another caller's input -- and that input can be a capability URL (a presigned
 * link, an invite token in a query string). Only the entries
 * `isExposableSharedUrl` vouches for are listed; the rest stay reachable by key,
 * which is what the cache is for.
 * @param {Request} req The request.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const storageList = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    fail(res, 401, "unauthorized")
    return
  }

  try {
    const store = await resolveBlobStore(uid, "user")
    if (!store) {
      fail(res, 501, "byob_unavailable")
      return
    }

    const [own, shared] = await Promise.all([
      store.list(userObjectKeyPrefix(uid), LIST_LIMIT),
      getPlatformBlobStore().list(SHARED_KEY_PREFIX, LIST_LIMIT),
    ])

    // A shared entry was saved by somebody else, and the URL it was saved FROM
    // can itself be a capability. Listing it would hand the caller a working
    // link they were never given, so only the entries whose URL carries
    // nothing capability-shaped are shown.
    const visible = shared.filter((blob) =>
      isExposableSharedUrl(blob.custom[META_URL] ?? "")
    )

    res.status(200).json({
      objects: [...own, ...visible].map(toPublicObject),
    })
  } catch (error) {
    console.error("storage: list failed:", errorLabel(error))
    fail(res, 500, "internal")
  }
}

/**
 * `POST /api/storage/presign` -- a short-lived read URL for one object.
 *
 * 404 rather than 403 for a key the caller may not read, so the response cannot
 * be used to discover whether another caller's object exists.
 * @param {Request} req The request carrying `{key}`.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const storagePresign = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    fail(res, 401, "unauthorized")
    return
  }

  const body = bodyOf(req)
  const key = typeof body["key"] === "string" ? body["key"].trim() : ""

  if (!key || !isReadableObjectKey(uid, key)) {
    fail(res, 404, "not_found")
    return
  }

  try {
    const store = isSharedObjectKey(key) ?
      getPlatformBlobStore() :
      await resolveBlobStore(uid, "user")

    if (!store) {
      fail(res, 501, "byob_unavailable")
      return
    }

    const url = await store.signedUrl(key, PRESIGN_TTL_SECONDS)

    res.status(200).json({url})
  } catch (error) {
    console.error("storage: presign failed:", errorLabel(error))
    fail(res, 500, "internal")
  }
}

/**
 * `GET /api/storage/object?key=...` -- the object's BYTES, under the normal
 * auth guard, with no URL credential minted at all.
 *
 * Why this exists beside `presign`
 * -------------------------------
 * A presigned URL is a bearer credential: anyone holding the string can read the
 * object until it expires, which is why the list route already filters out
 * shared entries whose URL is capability-shaped. This route is for VIEWING a
 * file the caller already has the right to read, and it hands out nothing that
 * outlives the response -- the caller's own bearer token is the only credential
 * in play, and it is checked here like every other route.
 *
 * A browser tab cannot attach an Authorization header to a navigation, so the
 * client does not open this URL directly: it fetches the bytes with its normal
 * authenticated request and renders them from a blob URL that never leaves the
 * page. That is the whole point -- the credential stays in the request that
 * carries it.
 *
 * 404 rather than 403 for a key the caller may not read, for the same reason
 * `presign` does it: the answer must not reveal that another caller's object
 * exists.
 * @param {Request} req The request carrying `?key=`.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const storageObject = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    fail(res, 401, "unauthorized")
    return
  }

  const raw = (req.query ?? {})["key"]
  const key = typeof raw === "string" ? raw.trim() : ""

  if (!key || !isReadableObjectKey(uid, key)) {
    fail(res, 404, "not_found")
    return
  }

  try {
    const store = isSharedObjectKey(key) ?
      getPlatformBlobStore() :
      await resolveBlobStore(uid, "user")

    if (!store) {
      fail(res, 501, "byob_unavailable")
      return
    }

    const meta = await store.stat(key)
    const bytes = meta ? await store.get(key) : null

    if (!bytes) {
      fail(res, 404, "not_found")
      return
    }

    const name = sanitizeFilename(key.split("/").pop() ?? "download")

    res.setHeader(
      "Content-Type",
      meta?.contentType || "application/octet-stream"
    )
    // `inline` so a PDF or an image opens in the tab it was fetched into; the
    // filename is sanitised because it comes back from the store.
    res.setHeader("Content-Disposition", `inline; filename="${name}"`)
    // The bytes are one caller's artifact: never in a shared cache, and never
    // reused from one without re-checking the token.
    res.setHeader("Cache-Control", "private, no-store")
    res.setHeader("Content-Length", String(bytes.length))

    res.status(200).send(bytes)
  } catch (error) {
    console.error("storage: object read failed:", errorLabel(error))
    fail(res, 500, "internal")
  }
}

/**
 * `POST /api/storage/delete` -- remove one of the caller's own objects.
 *
 * Reuses `isReadableObjectKey`, so a key the caller may not read is a 404 here
 * too rather than a 403: the answer must not reveal whether another caller's
 * object exists.
 *
 * A SHARED key is refused outright. The shared tier is a URL-keyed cache that
 * any authenticated caller can re-create, so evicting one is a cross-tenant
 * write with no owner to answer to -- and `delete_file` exists to remove the
 * caller's OWN saved files, which is a thing this can actually be right about.
 *
 * An absent key SUCCEEDS. `DeleteObject` is idempotent by specification and
 * the port documents absent-as-success, which is what lets a model that calls
 * this twice get a usable answer instead of an error.
 * @param {Request} req The request carrying `{key}`.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const storageDelete = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    fail(res, 401, "unauthorized")
    return
  }

  const body = bodyOf(req)
  const key = typeof body["key"] === "string" ? body["key"].trim() : ""

  if (!key || !isReadableObjectKey(uid, key)) {
    fail(res, 404, "not_found")
    return
  }

  if (isSharedObjectKey(key)) {
    fail(res, 403, "shared_object")
    return
  }

  try {
    const store = await resolveBlobStore(uid, "user")
    if (!store) {
      fail(res, 501, "byob_unavailable")
      return
    }

    await store.delete(key)

    res.status(200).json({key, deleted: true})
  } catch (error) {
    console.error("storage: delete failed:", errorLabel(error))
    fail(res, 500, "internal")
  }
}

/**
 * `GET /api/storage/settings` -- the mode, and whether a credential is on
 * record. Never the credential itself, never the endpoint.
 * @param {Request} req The request.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const storageGetSettings = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    fail(res, 401, "unauthorized")
    return
  }

  try {
    const settings = await readStorageSettings(uid)
    res.status(200).json(toPublicSettings(settings))
  } catch (error) {
    console.error("storage: settings read failed:", errorLabel(error))
    fail(res, 500, "internal")
  }
}

/**
 * `POST /api/storage/settings` -- set the mode, and for BYOB the bucket and its
 * credentials.
 *
 * The response is built by `writeStorageSettings`, which returns the
 * `StorageSettingsPublic` projection -- a type with no field a secret could
 * occupy -- so this route cannot echo what it just stored even by mistake.
 * @param {Request} req The request carrying the settings body.
 * @param {Response} res The response.
 * @return {Promise<void>} Resolves once the response is written.
 */
export const storageSetSettings = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = uidOf(req)
  if (!uid) {
    fail(res, 401, "unauthorized")
    return
  }

  const validation = validateStorageSettingsInput(bodyOf(req))
  if (!validation.ok) {
    fail(res, 400, validation.error)
    return
  }

  try {
    const settings = await writeStorageSettings(uid, validation.value)
    res.status(200).json(settings)
  } catch (error) {
    console.error("storage: settings write failed:", errorLabel(error))
    fail(res, 500, "internal")
  }
}
