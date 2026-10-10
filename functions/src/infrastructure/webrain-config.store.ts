/* eslint-disable object-curly-spacing */
/**
 * Runtime-readable webrain configuration.
 *
 * The problem
 * -----------
 * `getEnv()` freezes the environment into an object at module load, so a token
 * rotated in Secret Manager, or a proxy added to the pool, stayed invisible
 * until the next revision was deployed. Both are operational values: retiring a
 * leaked bearer token and swapping a burned proxy exit are routine, and both
 * belong on the next request rather than on the next deploy.
 *
 * Storage
 * -------
 * One secret, `WEBRAIN_CONFIG`, whose payload is JSON:
 *
 *   {"mcpToken": "...",
 *    "proxies": ["http://user:pass@host:port", ...],
 *    "workers": ["http://worker-host:9223", ...]}
 *
 * `workers` is the browser-worker pool, and it is a separate list from
 * `proxies` rather than one list of endpoints: a leased worker serves exactly
 * one tenant at a time, so the list is capacity, while a proxy list is
 * interchangeable egress. A worker URL also carries no credentials, where a
 * proxy URL is `user:pass@host`, and conflating them would put a worker behind
 * a labeller written for secrets.
 *
 * Read and written through the emulator-aware helpers in `app/config.ts`, so
 * there is no second Secret Manager client and no new dependency.
 *
 * The cache
 * ---------
 * A resolved document is served for `WEBRAIN_CONFIG_TTL_MS` before the next
 * read reaches Secret Manager, so a burst of calls costs ONE access rather than
 * one per call. A failed read is never fatal: the last good value is served
 * again for another TTL and the failure is logged by class name only. Nothing
 * here rejects into a caller.
 *
 * Secrets are never logged or echoed
 * ----------------------------------
 * A proxy URL is `user:pass@host`, i.e. a credential, and the token is a bearer
 * credential. Nothing in this file prints either: the failure line names the
 * operation and the error's class, never a value or a URL.
 */
import {
  getSecretFromManager,
  purgeSecretAndAllRevisions,
  secretPathFor,
  upsertSecretValue,
} from "../app/config"
import { env } from "../config/env"
import type { ProxyEntry } from "../domain/webrain-proxy.domain"
import { workerLabel, type WorkerEntry } from "../domain/webrain-workers.domain"

/** The Secret Manager id holding the JSON document. */
export const WEBRAIN_CONFIG_SECRET = "WEBRAIN_CONFIG"

/**
 * How long a resolved document is served before Secret Manager is read again.
 *
 * 30s is the compromise between the two costs. Shorter makes a rotation visible
 * sooner; longer makes a burst cheaper. It turns one-access-per-call into
 * one-access-per-30s while still landing a rotation inside an operator's next
 * manual step, and a wrong value can be corrected within one TTL.
 */
export const WEBRAIN_CONFIG_TTL_MS = 30_000

/** The resolved triple, which is all the readers expose. */
export interface WebrainConfig {
  mcpToken: string
  proxies: ProxyEntry[]
  workers: WorkerEntry[]
}

/** A served value and the moment it stops being fresh. */
interface CachedConfig {
  value: WebrainConfig
  expiresAt: number
}

let cached: CachedConfig | null = null
let inFlight: Promise<WebrainConfig> | null = null

/**
 * Which seam the last resolved pair came from.
 *
 * The admin status route reports this so an operator can tell a rotation that
 * has taken effect from one that only looks like it has: `"secret"` means the
 * stored document answered, `"env"` means the environment fallback did. It is a
 * single word, never a value.
 */
let resolvedSource: "secret" | "env" = "env"

/**
 * A host-derived label for an entry that does not declare one.
 *
 * The host only. An unparseable entry falls back to its position rather than to
 * the raw string, which is where a `user:pass` could otherwise reach a log or
 * an admin table.
 * @param {string} url The proxy URL.
 * @param {number} index Its position in the pool.
 * @return {string} A label that is safe to display.
 */
const labelFor = (url: string, index: number): string => {
  try {
    return new URL(url).hostname || `proxy-${index + 1}`
  } catch {
    return `proxy-${index + 1}`
  }
}

/**
 * One stored entry: a bare URL string, or an object with a label.
 *
 * The labeller is a parameter because the two pools disagree about how to name
 * an endpoint: a proxy is named by host, a worker must also carry its port. The
 * shape is otherwise identical, so this stays one function rather than two that
 * would drift.
 * @param {unknown} item The raw entry.
 * @param {number} index Its position, used for the label fallback.
 * @param {function} labeller Builds a display label for a URL and position.
 * @return {{label: string, url: string}|null} The entry, or null if unusable.
 */
const toEntry = (
  item: unknown,
  index: number,
  labeller: (url: string, index: number) => string
): {label: string, url: string} | null => {
  if (typeof item === "string") {
    const url = item.trim()
    return url ? {label: labeller(url, index), url} : null
  }

  if (item && typeof item === "object") {
    const record = item as {label?: unknown, url?: unknown}
    const url = typeof record.url === "string" ? record.url.trim() : ""
    if (!url) {
      return null
    }

    const label = typeof record.label === "string" ?
      record.label.trim() :
      ""
    return {label: label || labeller(url, index), url}
  }

  return null
}

/**
 * A pool list out of a stored document, with blanks dropped.
 * @param {unknown} value The raw `proxies` or `workers` field.
 * @param {function} labeller Builds a display label for a URL and position.
 * @return {Array<{label: string, url: string}>} Usable entries, in order.
 */
const toEntries = (
  value: unknown,
  labeller: (url: string, index: number) => string
): Array<{label: string, url: string}> => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item, index) => toEntry(item, index, labeller))
    .filter((entry): entry is {label: string, url: string} => entry !== null)
}

/**
 * The environment's own configuration, which is what local dev and the current
 * deployed setup use.
 * @return {WebrainConfig} The env-derived pair, empty when unconfigured.
 */
const fromEnv = (): WebrainConfig => {
  // ONE name to rotate. Read the ENGINE's own name first, then the platform's
  // legacy alias — see `config/env.ts` for the full reasoning. This site reads
  // `process.env` directly as well as `env`, so it needs the same precedence or
  // a deployment that set only `WEBRAIN_HTTP_TOKEN` would authenticate in
  // `env.ts` and be ignored here.
  const rawToken =
    process.env["WEBRAIN_HTTP_TOKEN"] ??
    process.env["WEBRAIN_MCP_TOKEN"] ??
    env.WEBRAIN_MCP_TOKEN
  const token = (rawToken ?? "").trim()

  const proxies = (process.env["WEBRAIN_PROXY_POOL"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((url, index) => ({label: labelFor(url, index), url}))

  // `workerLabel`, not `labelFor`. A worker pool puts several endpoints on one
  // host -- ports locally, or one machine running `--workers N` -- and a
  // hostname-only label would collapse them into a single lease key. See
  // `domain/webrain-workers.domain.ts`.
  const workers = (process.env["WEBRAIN_WORKER_POOL"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((url, index) => ({label: workerLabel(url, index), url}))

  return {mcpToken: token, proxies, workers}
}

/**
 * The stored document, or null when it is absent, empty or unreadable.
 * @param {string|undefined} raw The secret payload.
 * @return {WebrainConfig|null} The parsed pair, or null.
 */
const parseConfig = (raw: string | undefined): WebrainConfig | null => {
  if (!raw) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // The line names the shape, never the content: a parse error can quote the
    // text it choked on, and that text is a credential.
    console.warn("webrain-config: WEBRAIN_CONFIG is not valid JSON")
    return null
  }

  if (!parsed || typeof parsed !== "object") {
    return null
  }

  const record = parsed as Record<string, unknown>
  const token = typeof record["mcpToken"] === "string" ?
    record["mcpToken"].trim() :
    ""
  const proxies = toEntries(record["proxies"], labelFor)
  const workers = toEntries(record["workers"], workerLabel)

  if (!token && proxies.length === 0 && workers.length === 0) {
    return null
  }

  return {mcpToken: token, proxies, workers}
}

/**
 * Reads the pair and refreshes the cache.
 *
 * Never rejects: the caller is an HTTP route that has to answer, so a failed
 * read serves the last good value, then the environment. Caching the fallback
 * too is what keeps an unconfigured secret -- today's steady state, where the
 * values come from env -- from putting an access on every webrain call.
 * @return {Promise<WebrainConfig>} The pair, never a rejection.
 */
const load = async (): Promise<WebrainConfig> => {
  let value: WebrainConfig

  try {
    const raw = await getSecretFromManager(
      secretPathFor(WEBRAIN_CONFIG_SECRET)
    )
    const parsed = parseConfig(raw)
    value = parsed ?? fromEnv()
    resolvedSource = parsed ? "secret" : "env"
  } catch (error) {
    value = cached?.value ?? fromEnv()
    // A failed read with a cached value keeps describing the cached value's
    // seam; with nothing cached the environment answered.
    resolvedSource = cached ? resolvedSource : "env"
    // Message and class only. A Secret Manager error can quote the resource
    // path, and the resource is not the secret -- but a value never is.
    console.warn(
      "webrain-config: read failed, serving the last known value:",
      error instanceof Error ? error.name : typeof error
    )
  }

  cached = {value, expiresAt: Date.now() + WEBRAIN_CONFIG_TTL_MS}
  return value
}

/**
 * The resolved pair, from cache while it is fresh.
 *
 * `inFlight` collapses concurrent cold calls into one read: a burst of webrain
 * calls on a cold instance would otherwise each pay for their own access.
 * @return {Promise<WebrainConfig>} The pair, never a rejection.
 */
const resolve = async (): Promise<WebrainConfig> => {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value
  }

  if (inFlight) {
    return inFlight
  }

  inFlight = load()
  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

/**
 * The worker's bearer token, or "" when none is configured.
 *
 * Resolved per call through the TTL cache, so a rotation reaches a warm
 * instance without a redeploy.
 * @return {Promise<string>} The token, never a rejection.
 */
export const webrainMcpToken = async (): Promise<string> =>
  (await resolve()).mcpToken

/**
 * The worker egress pool, normalised to labelled entries.
 *
 * An empty result means "no proxy", which is the pre-existing behaviour and
 * still the behaviour when the pool is deliberately cleared.
 * @return {Promise<ProxyEntry[]>} Usable exits, in configured order.
 */
export const webrainProxyPool = async (): Promise<ProxyEntry[]> =>
  (await resolve()).proxies

/**
 * The browser-worker pool, normalised to labelled entries.
 *
 * An empty result means "no pool configured" -- today's state, since the pool
 * is supplied by the `WEBRAIN_WORKER_POOL` environment variable or the stored
 * document. A caller that needs a browser therefore has to refuse rather than
 * falling back to a browserless fetch, which would answer a JS shell as if it
 * were content. Selection and the exclusivity rule live in
 * `domain/webrain-workers.domain.ts`; this only supplies the set.
 * @return {Promise<WorkerEntry[]>} Usable workers, in configured order.
 */
export const webrainWorkerPool = async (): Promise<WorkerEntry[]> =>
  (await resolve()).workers

/**
 * Which seam the last resolved pair came from.
 *
 * Resolved through the same TTL cache as the readers, so it describes the
 * resolution the caller just received rather than a fresh probe that could
 * disagree with it. Reported by the admin status route, never as a value.
 * @return {Promise<"secret"|"env">} The seam that answered.
 */
export const webrainConfigSource = async (): Promise<"secret" | "env"> => {
  await resolve()
  return resolvedSource
}

/**
 * Stores the pair, merging over what is currently resolved.
 *
 * The merge is what stops a token rotation from silently dropping the pool, and
 * it also means the FIRST write snapshots the environment fallback, so turning
 * the secret on does not change behaviour.
 *
 * Rotation uses `upsertSecretValue`, not `saveToSecretManager`: the latter
 * calls `createSecret`, so the second save of a live secret answers
 * `ALREADY_EXISTS`. Purge-then-create would destroy the revisions but cannot
 * recreate the name during Secret Manager's deletion window, which is a
 * rotation that fails exactly when it is needed.
 * @param {*} patch The fields to write: an optional `mcpToken` string and/or
 * an optional `proxies` array of URL strings and/or an optional `workers`
 * array of worker base URLs.
 * @return {Promise<void>} Resolves once the document is stored.
 */
export const saveWebrainConfig = async (patch: {
  mcpToken?: string
  proxies?: string[]
  workers?: string[]
}): Promise<void> => {
  const current = await resolve()
  const document = {
    mcpToken: patch.mcpToken ?? current.mcpToken,
    proxies: patch.proxies ?? current.proxies.map((entry) => entry.url),
    workers: patch.workers ?? current.workers.map((entry) => entry.url),
  }

  await upsertSecretValue(WEBRAIN_CONFIG_SECRET, JSON.stringify(document))
  cached = null
  inFlight = null
}

/**
 * Removes the stored document, returning readers to the env fallback.
 * @return {Promise<void>} Resolves even when there was nothing to remove.
 */
export const clearWebrainConfig = async (): Promise<void> => {
  try {
    await purgeSecretAndAllRevisions(secretPathFor(WEBRAIN_CONFIG_SECRET))
  } catch (error) {
    // Absent is the normal case after a clear, and it is not an error here.
    console.warn(
      "webrain-config: clear found nothing to remove:",
      error instanceof Error ? error.name : typeof error
    )
  }

  cached = null
  inFlight = null
}
