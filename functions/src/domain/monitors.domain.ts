/* eslint-disable object-curly-spacing */
/**
 * The monitor model, and the rules one check applies to a page.
 *
 * Why this is a domain module and not logic inside the handlers
 * ------------------------------------------------------------
 * Three callers need the SAME answers and none of them is the other's child:
 * the CRUD routes (what a create/patch may say), the scheduler's check runner
 * (whether a page changed), and the tests. `url-guard.domain.ts` and
 * `webrain-tools.domain.ts` are split out for the same reason — a rule with
 * two copies is a rule that will disagree with itself.
 *
 * What a monitor is, and what it deliberately is not
 * -------------------------------------------------
 * v1 stores METADATA ONLY: a hash of the body, the validators we were given,
 * and one row per check. It never stores the page. There is no object store in
 * this repo (verified: no S3/Tigris client), so a monitor that stored bodies
 * would be a monitor that silently grew a bucket it cannot write to.
 *
 * The 304 rule, which is the whole point
 * -------------------------------------
 * `304 Not Modified` is a TERMINAL SUCCESS meaning "unchanged" — the server has
 * vouched for the copy we already hashed, so there is nothing to transfer and
 * nothing to compare. `monitorCheckFromScrape` therefore returns before it ever
 * looks for a body. The SERP fetcher does the opposite (it treats a bodyless
 * 304 as a cache miss and re-requests unconditionally, see
 * `webrain-core/src/engines.rs::serp_http_get`), and inheriting that here would
 * turn the cheapest possible check into one full download per run.
 *
 * See `monitorCheckFromScrape` for the two limits the worker imposes on the
 * rest of this — they are real, and they are documented rather than papered
 * over.
 */
import { createHash } from "node:crypto"
import { targetUrlFrom } from "./url-guard.domain"

/** What the last check concluded, and what a check row records. */
export type MonitorStatus = "unchanged" | "changed" | "error"

/**
 * The shortest interval a monitor may run at.
 *
 * One check is one worker request against a SHARED pool, so the floor is what
 * stops a single account from monopolising the pool that every other account is
 * queued behind. Five minutes is also below any page's worth watching by hand.
 */
export const MONITOR_MIN_INTERVAL_MINUTES = 5

/** The longest interval: a week. Past this, a monitor is a calendar entry. */
export const MONITOR_MAX_INTERVAL_MINUTES = 7 * 24 * 60

/** What a create gets when the caller does not choose. */
export const MONITOR_DEFAULT_INTERVAL_MINUTES = 60

/**
 * How many monitors one account may hold.
 *
 * Monitoring is available on the free tier, so this is the only thing bounding
 * a free account's scheduled work: 20 monitors at the 5-minute floor is 5,760
 * worker requests a day for one account, which is already generous.
 */
export const MONITOR_MAX_PER_USER = 20

/**
 * Longest accepted monitor name: long enough for a URL, short enough to list.
 */
export const MONITOR_NAME_MAX_LENGTH = 120

/**
 * Check rows kept per monitor.
 *
 * A check row is four numbers and a hash, and the cost being controlled is
 * per-document READS: `GET /monitor/checks` reads this collection, so an
 * unbounded history is an unbounded bill for one page's history. 200 rows is
 * the newest 200 checks — at the 5-minute floor that is 16 hours, and at the
 * default hourly interval it is more than a week.
 */
export const MONITOR_CHECK_RETENTION = 200

/**
 * Rows deleted per prune, AND the slack allowed above the retention bound
 * before a prune runs at all.
 *
 * One number doing both jobs on purpose. Pruning every write would cost a
 * `count()` plus a delete on every single check; pruning only once the
 * collection is `MONITOR_PRUNE_BATCH` over the bound amortises the same work to
 * about one read and one delete per check, which is what keeps the retention
 * bound from becoming the expensive part of a check.
 */
export const MONITOR_PRUNE_BATCH = 25

/**
 * Monitors the scheduler claims per run.
 *
 * Each claimed monitor is one worker request, and the scheduler runs every five
 * minutes — so this is the ceiling on how much of the shared pool the drain can
 * take in one burst. 25 x 288 runs is ~7,200 checks a day of capacity, and a
 * backlog drains over later runs because every run re-queries rather than
 * tracking a cursor.
 */
export const MONITOR_DRAIN_BATCH = 25

/**
 * Where a DISABLED monitor parks its due-time.
 *
 * Firestore has no conditional index: `where(enabled == true)` combined with a
 * range on another field is a composite index, and a second filter is a second
 * thing to deploy. Parking a disabled monitor's `nextCheckAt` beyond any wall
 * clock keeps it out of the single-field range query the drain uses, with no
 * index and no stale row returned on every run.
 */
export const MONITOR_DISABLED_NEXT_CHECK = Number.MAX_SAFE_INTEGER

/** The most check rows one request may read. */
export const MONITOR_CHECKS_LIMIT_MAX = 100

/** What `GET /monitor/checks` returns when the caller does not choose. */
export const MONITOR_CHECKS_LIMIT_DEFAULT = 25

/**
 * Every stored field of one monitor, except the document id.
 *
 * `nextCheckAt` is not in the shape the brief described, and it is here on
 * purpose: Firestore cannot do arithmetic on a field inside a query, so
 * "whose turn is it?" cannot be computed at read time. Without a stored,
 * single-field-indexed due-time the drain would have to read EVERY monitor to
 * find the due ones.
 */
export interface MonitorFields {
  uid: string
  url: string
  name: string
  intervalMinutes: number
  enabled: boolean
  selector?: string
  extractMode?: string
  lastCheckedAt?: number
  lastStatus?: MonitorStatus
  lastHash?: string
  lastEtag?: string
  lastModified?: string
  consecutiveErrors: number
  createdAt: number
  updatedAt: number
  nextCheckAt: number
}

/** One monitor as the store hands it back. */
export type MonitorRecord = MonitorFields & { id: string }

/** One row of `monitors/{id}/checks`. */
export interface MonitorCheckFields {
  at: number
  status: MonitorStatus
  httpStatus: number
  hash?: string
  changed: boolean
  ms?: number
  error?: string
}

/** A check row with its document id. */
export type MonitorCheckRecord = MonitorCheckFields & { id: string }

/** What one check concluded, before it is written. */
export interface MonitorCheckOutcome {
  status: MonitorStatus
  httpStatus: number
  changed: boolean
  hash?: string
  error?: string
}

/** A create's verdict: the document to write, or why it is refused. */
export type MonitorCreate =
  | { ok: true; monitor: MonitorFields }
  | { ok: false; error: string }

/** A patch's verdict: the fields to merge, or why it is refused. */
export type MonitorPatch =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; error: string }

/** The body of `POST /monitor/create`, unvalidated. */
export interface MonitorCreateBody {
  url?: unknown
  name?: unknown
  intervalMinutes?: unknown
  selector?: unknown
  extractMode?: unknown
}

/**
 * sha256 of a page body, hex.
 *
 * The comparison key when the origin sends no validator at all — which is most
 * pages. It is a HASH, not the body: this is what makes "changed" detectable
 * without storing anything we would then have to protect.
 * @param {string} text The body to digest.
 * @return {string} The hex digest.
 */
export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex")

/**
 * An interval inside the allowed range, or the default.
 *
 * Clamped rather than refused, matching how `/serp` clamps `limit`: the caller
 * asked for "about this often", and a 1-minute request served at 5 is a
 * correctly-running monitor rather than a 400 the user cannot act on.
 * @param {unknown} value The requested interval.
 * @return {number} A whole number of minutes inside the bounds.
 */
export const clampIntervalMinutes = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return MONITOR_DEFAULT_INTERVAL_MINUTES
  }

  const minutes = Math.floor(value)
  if (minutes < MONITOR_MIN_INTERVAL_MINUTES) {
    return MONITOR_MIN_INTERVAL_MINUTES
  }
  if (minutes > MONITOR_MAX_INTERVAL_MINUTES) {
    return MONITOR_MAX_INTERVAL_MINUTES
  }

  return minutes
}

/**
 * When a monitor is next due.
 *
 * A disabled monitor gets the sentinel, which is the whole mechanism by which
 * `enabled: false` removes it from the drain's range query. See
 * `MONITOR_DISABLED_NEXT_CHECK`.
 * @param {boolean} enabled Whether the monitor is switched on.
 * @param {number} intervalMinutes Its interval, already clamped.
 * @param {number} from The instant to measure from.
 * @return {number} Epoch milliseconds.
 */
export const nextCheckAtFor = (
  enabled: boolean,
  intervalMinutes: number,
  from: number
): number =>
  enabled ? from + intervalMinutes * 60_000 : MONITOR_DISABLED_NEXT_CHECK

/**
 * A URL we are willing to hand to a worker, or undefined.
 *
 * Delegates to the platform's one target-URL guard rather than re-checking
 * http(s) here: a monitor pointed at `169.254.169.254` is the same class of
 * mistake as a crawl pointed there, and the guard is the module that owns the
 * answer. It is a PRE-request check — a redirect past it is not caught, see
 * `docs/RESIDUAL-RISK-CRAWL-TRUST-BOUNDARY.md`.
 * @param {unknown} value The candidate URL.
 * @return {string | undefined} The trimmed URL, or undefined.
 */
export const monitorUrlFrom = (value: unknown): string | undefined =>
  targetUrlFrom(value)

/**
 * A trimmed, non-empty string of at most `max` characters.
 * @param {unknown} value The candidate.
 * @param {number} max The longest accepted length.
 * @return {string | undefined} The trimmed value, or undefined.
 */
export const boundedString = (
  value: unknown,
  max: number
): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length && trimmed.length <= max ? trimmed : undefined
}

/**
 * A trimmed, non-empty optional string, or undefined.
 *
 * `undefined` is the correct answer for "not given" AND for "given as junk",
 * because both mean the monitor runs without that refinement — and neither is
 * worth failing a create over.
 * @param {unknown} value The candidate.
 * @return {string | undefined} The trimmed value, or undefined.
 */
export const optionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

/**
 * Validates a create and builds the document to write.
 *
 * The name defaults to the URL rather than failing: a monitor is identified by
 * what it watches, and refusing a nameless one would only force the client to
 * echo the URL back.
 * @param {string} uid The owning account.
 * @param {MonitorCreateBody} body The parsed request body.
 * @param {number} now Epoch milliseconds.
 * @return {MonitorCreate} The document fields, or why the body is refused.
 */
export const buildMonitorFields = (
  uid: string,
  body: MonitorCreateBody,
  now: number
): MonitorCreate => {
  const url = monitorUrlFrom(body?.url)
  if (!url) {
    return {
      ok: false,
      error:
        "A monitor needs an http(s) url that is not a private address",
    }
  }

  // A name that was SENT but is unusable is refused rather than replaced by the
  // url: silently renaming a monitor the user just named is the kind of
  // correction that hides a client's own bug. Omitting the name is different —
  // that is what the url default exists for.
  const given = body?.name
  const named = boundedString(given, MONITOR_NAME_MAX_LENGTH)
  if (given !== undefined && !named) {
    return {
      ok: false,
      error: `A monitor name must be 1-${MONITOR_NAME_MAX_LENGTH} chars`,
    }
  }

  const name = named ?? url
  const intervalMinutes = clampIntervalMinutes(body?.intervalMinutes)
  const monitor: MonitorFields = {
    uid,
    url,
    name,
    intervalMinutes,
    enabled: true,
    consecutiveErrors: 0,
    createdAt: now,
    updatedAt: now,
    nextCheckAt: nextCheckAtFor(true, intervalMinutes, now),
  }

  const selector = optionalString(body?.selector)
  if (selector) {
    monitor.selector = selector
  }

  const extractMode = optionalString(body?.extractMode)
  if (extractMode) {
    monitor.extractMode = extractMode
  }

  return { ok: true, monitor }
}

/**
 * Validates a patch against the monitor it will be merged into.
 *
 * Only the fields below may be patched; `uid`, `createdAt` and the check
 * bookkeeping are not the caller's to write, and a patch that named them is
 * ignored rather than refused (a returning client that echoes a whole document
 * back should not be an error).
 *
 * `undefined` values are never put in the returned patch: Firestore rejects an
 * undefined field value outright, so a patch that "cleared" a field by sending
 * undefined would throw at the write rather than at the validation.
 * @param {MonitorFields} current The monitor as stored.
 * @param {Record<string, unknown>} body The parsed request body.
 * @param {number} now Epoch milliseconds.
 * @return {MonitorPatch} The fields to merge, or why the patch is refused.
 */
export const buildMonitorPatch = (
  current: MonitorFields,
  body: Record<string, unknown>,
  now: number
): MonitorPatch => {
  const patch: Record<string, unknown> = {}

  if (body?.["url"] !== undefined) {
    const url = monitorUrlFrom(body["url"])
    if (!url) {
      return {
        ok: false,
        error:
          "A monitor needs an http(s) url that is not a private address",
      }
    }
    patch["url"] = url
  }

  if (body?.["name"] !== undefined) {
    const name = boundedString(body["name"], MONITOR_NAME_MAX_LENGTH)
    if (!name) {
      return {
        ok: false,
        error: `A monitor name must be 1-${MONITOR_NAME_MAX_LENGTH} chars`,
      }
    }
    patch["name"] = name
  }

  if (body?.["intervalMinutes"] !== undefined) {
    patch["intervalMinutes"] = clampIntervalMinutes(body["intervalMinutes"])
  }

  if (typeof body?.["enabled"] === "boolean") {
    patch["enabled"] = body["enabled"]
  }

  if (body?.["selector"] !== undefined) {
    const selector = optionalString(body["selector"])
    if (selector) {
      patch["selector"] = selector
    } else {
      patch["selector"] = null
    }
  }

  if (body?.["extractMode"] !== undefined) {
    const extractMode = optionalString(body["extractMode"])
    if (extractMode) {
      patch["extractMode"] = extractMode
    } else {
      patch["extractMode"] = null
    }
  }

  if (!Object.keys(patch).length) {
    return { ok: false, error: "Nothing to update" }
  }

  const enabled = typeof patch["enabled"] === "boolean" ?
    patch["enabled"] :
    current.enabled
  const intervalMinutes = typeof patch["intervalMinutes"] === "number" ?
    patch["intervalMinutes"] :
    current.intervalMinutes

  // Re-derive the due-time from whatever the patch left behind, so an edit that
  // changes the interval (or switches the monitor on) takes effect now rather
  // than at the end of the old interval.
  patch["nextCheckAt"] = nextCheckAtFor(enabled, intervalMinutes, now)
  patch["updatedAt"] = now

  return { ok: true, patch }
}

/**
 * Whether this monitor belongs to this account.
 *
 * The single scoping rule for the whole monitor surface. It is a function so
 * that the routes cannot each answer it slightly differently, and it is called
 * on EVERY read and every write — a monitor is addressed by an id the caller
 * supplies, so the id alone proves nothing.
 * @param {MonitorFields | undefined} monitor The stored monitor.
 * @param {string} uid The calling account.
 * @return {boolean} True only when the monitor exists and is the caller's.
 */
export const isOwnedBy = (
  monitor: MonitorFields | undefined,
  uid: string
): boolean => Boolean(monitor) && monitor?.uid === uid

/**
 * The scrape payload's `result` object, when there is one.
 *
 * `webrain_scrape` answers `{"status":"ok","result":{…}}` and reports its own
 * failures as `{"status":"error","message":…}` in the SAME envelope, so the two
 * have to be told apart before anything reads a field. `result.status` is the
 * HTTP status (a number) while the outer `status` is a string — a distinction
 * that is easy to lose and produces a monitor that never reports a change.
 * @param {unknown} payload The parsed tool payload.
 * @return {Record<string, unknown> | undefined} The result object, if any.
 */
export const scrapeResultOf = (
  payload: unknown
): Record<string, unknown> | undefined => {
  if (!payload || typeof payload !== "object") {
    return undefined
  }
  const result = (payload as Record<string, unknown>)["result"]
  if (!result || typeof result !== "object") {
    return undefined
  }
  return result as Record<string, unknown>
}

/**
 * What one check concluded, from the worker's answer.
 *
 * `previousHash` is the hash stored on the monitor, or undefined for the first
 * check ever — and the first check is deliberately "unchanged", not "changed":
 * a monitor starts from "I have seen nothing", and reporting the baseline as a
 * change would fire an alert the moment a monitor is created.
 *
 * Two limits of the worker are visible here, and both are facts rather than
 * choices:
 *
 *  - The conditional request is the WORKER's, not ours. `webrain_scrape` maps
 *    to `webrain_fetch_http`, which reads only `url` — no tool argument carries
 *    `If-None-Match` / `If-Modified-Since` — so this route cannot ask a
 *    conditional question itself. The 304 branch below is therefore a terminal
 *    success for a 304 the worker DOES surface, and a no-op until one does.
 *  - `webrain_fetch_http` truncates a non-JSON body to 3000 characters, so the
 *    hash covers the head of the page. A change below that point is invisible
 *    to this check. That is why `changed` is a hash comparison and not a claim
 *    that the page is identical.
 * @param {unknown} payload The parsed `webrain_scrape` payload.
 * @param {string | undefined} previousHash The hash last stored.
 * @return {MonitorCheckOutcome} The status, HTTP status and hash.
 */
export const monitorCheckFromScrape = (
  payload: unknown,
  previousHash: string | undefined
): MonitorCheckOutcome => {
  if (payload && typeof payload === "object") {
    const envelope = payload as Record<string, unknown>
    if (envelope["status"] === "error") {
      const message = optionalString(envelope["message"])
      return {
        status: "error",
        httpStatus: 0,
        changed: false,
        error: message ?? "The provider returned an error",
      }
    }
  }

  const result = scrapeResultOf(payload)
  if (!result) {
    return {
      status: "error",
      httpStatus: 0,
      changed: false,
      error: "The worker returned no page",
    }
  }

  const httpStatus =
    typeof result["status"] === "number" ? result["status"] : 0

  if (httpStatus === 304) {
    // Terminal. The server has vouched for the copy we hashed, so there is no
    // body to read and nothing to compare — the cheapest outcome there is.
    return { status: "unchanged", httpStatus, changed: false }
  }

  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      status: "error",
      httpStatus,
      changed: false,
      error: `The page answered ${httpStatus}`,
    }
  }

  const text = typeof result["text"] === "string" ? result["text"] : ""
  const hash = sha256Hex(text)

  // A first check ESTABLISHES the baseline; it is not a change. `changed` needs
  // a previous hash to differ from, and reporting the first observation as a
  // change would make every monitor fire once the moment it is created.
  const changed = previousHash !== undefined && hash !== previousHash

  return {
    status: changed ? "changed" : "unchanged",
    httpStatus,
    changed,
    hash,
  }
}

/**
 * The new error streak after a check.
 *
 * Reset by anything that is not an error, including "unchanged" — a monitor
 * that answers again is working, and a streak that only ever grew would make
 * the number useless for deciding whether to keep the monitor.
 * @param {number} previous The streak before this check.
 * @param {MonitorStatus} status What this check concluded.
 * @return {number} The streak to store.
 */
export const nextConsecutiveErrors = (
  previous: number,
  status: MonitorStatus
): number => (status === "error" ? Math.max(previous, 0) + 1 : 0)

/**
 * The stored `lastEtag` / `lastModified` the worker reported, if any.
 *
 * Kept as fields because the model specifies them and a worker that starts
 * reporting them fills them with no migration — but `webrain_fetch_http` does
 * not return either header today, so this returns an empty object in practice.
 * Said out loud rather than silently omitted, because "the monitor stores
 * validators" is a claim that is currently false.
 * @param {unknown} payload The parsed `webrain_scrape` payload.
 * @return {Record<string, string>} The validators the worker reported.
 */
export const validatorsFromScrape = (
  payload: unknown
): Record<string, string> => {
  const result = scrapeResultOf(payload)
  if (!result) {
    return {}
  }

  const validators: Record<string, string> = {}
  const etag = optionalString(result["etag"])
  if (etag) {
    validators["lastEtag"] = etag
  }
  const lastModified = optionalString(result["last_modified"])
  if (lastModified) {
    validators["lastModified"] = lastModified
  }
  return validators
}

/**
 * The `id` and `limit` of `GET /monitor/checks`.
 *
 * Reads the query string first and the body second: a GET carrying a JSON body
 * is unusual but legal, and the route is documented with a body, so accepting
 * both is one line cheaper than being wrong about which one a client sends.
 * @param {unknown} query The parsed query string.
 * @param {unknown} body The parsed body, if any.
 * @return {*} The request, or why it is refused.
 */
export const parseChecksRequest = (
  query: unknown,
  body: unknown
): { ok: true; id: string; limit: number } | { ok: false; error: string } => {
  const fromQuery = query && typeof query === "object" ?
    (query as Record<string, unknown>) :
    {}
  const fromBody = body && typeof body === "object" ?
    (body as Record<string, unknown>) :
    {}

  const id = optionalString(fromQuery["id"]) ?? optionalString(fromBody["id"])
  if (!id) {
    return { ok: false, error: "Missing monitor id" }
  }

  const raw =
    fromQuery["limit"] !== undefined ? fromQuery["limit"] : fromBody["limit"]
  const parsed = typeof raw === "string" ? Number(raw) : raw

  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, id, limit: MONITOR_CHECKS_LIMIT_DEFAULT }
  }

  if (typeof parsed !== "number" || !Number.isInteger(parsed)) {
    return {
      ok: false,
      error: `limit must be a whole number of 1-${MONITOR_CHECKS_LIMIT_MAX}`,
    }
  }

  const limit = Math.min(
    Math.max(parsed, 1),
    MONITOR_CHECKS_LIMIT_MAX
  )
  return { ok: true, id, limit }
}
