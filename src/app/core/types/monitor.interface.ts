/**
 * The site-monitor surface of the BFF.
 *
 * A monitor watches one URL on an interval and records whether the page changed
 * since the previous check. The BFF owns the actual checking; this file only
 * describes what crosses the wire, so the UI cannot invent a field the route
 * will not return.
 *
 * Route contract (`src/app/core/services/monitor.service.ts` is the only writer):
 *
 *   POST /api/monitor/create   { url, name, intervalMinutes, selector?, extractMode? } -> { id }
 *   GET  /api/monitor/list                                                             -> { monitors }
 *   POST /api/monitor/update   { id, ...patch }                                        -> { ok }
 *   POST /api/monitor/delete   { id }                                                  -> { ok }
 *   GET  /api/monitor/checks?id=<id>&limit=<n>                                         -> { checks }
 *
 * The optional fields on `Monitor` are optional because a monitor that has never
 * fired has no `lastCheckedAt` and one that has never succeeded has no
 * `lastStatus`; typing them as required would put `undefined` in front of the
 * user at the first `monitor.lastStatus.toUpperCase()`.
 */

/** Why the last check ended the way it did. */
export type MonitorLastStatus = 'unchanged' | 'changed' | 'error'

/** The status recorded on a single check. Same vocabulary as `MonitorLastStatus`. */
export type MonitorCheckStatus = 'unchanged' | 'changed' | 'error'

/**
 * What the monitor extracts from the page for comparison.
 *
 * The BFF owns this vocabulary. The three values here are the ones the create
 * form offers; a monitor created outside this UI carrying a different value is
 * still rendered, because `extractMode` is read back verbatim rather than
 * switched on.
 */
export type MonitorExtractMode = 'text' | 'markdown' | 'html'

/** One watched URL. */
export interface Monitor {
  id: string
  url: string
  name: string
  /** How often the BFF checks the URL, in minutes. */
  intervalMinutes: number
  /** `false` after a pause; a paused monitor keeps its history. */
  enabled: boolean
  /** CSS selector narrowing the compared region. */
  selector?: string
  extractMode?: MonitorExtractMode
  /** Unix milliseconds of the last completed check. Absent before the first run. */
  lastCheckedAt?: number
  /** Outcome of the last completed check. Absent before the first run. */
  lastStatus?: MonitorLastStatus
  lastHash?: string
  lastEtag?: string
  lastModified?: string
  /**
   * Failures since the last success.
   *
   * Present on every monitor rather than optional: the BFF counts it from zero,
   * so zero is a real reading and "absent" would be indistinguishable from
   * "never checked".
   */
  consecutiveErrors: number
  /** Unix milliseconds. */
  createdAt: number
  /** Unix milliseconds. */
  updatedAt: number
}

/** One entry in a monitor's change history. */
export interface Check {
  id: string
  /** Unix milliseconds. */
  at: number
  status: MonitorCheckStatus
  httpStatus: number
  hash?: string
  changed: boolean
  /** Round-trip time of the check, in milliseconds. */
  ms?: number
  /** The failure message, present only when `status` is `error`. */
  error?: string
}

/** What the create form sends. */
export interface MonitorCreateRequest {
  url: string
  name: string
  intervalMinutes: number
  selector?: string
  extractMode?: MonitorExtractMode
}

/**
 * What a patch sends.
 *
 * `id` plus any subset of the editable fields. It is a type rather than
 * `Partial<Monitor>` so a caller cannot send `lastHash` or `createdAt` and have
 * the server decide what that means.
 */
export interface MonitorUpdateRequest {
  id: string
  name?: string
  url?: string
  intervalMinutes?: number
  enabled?: boolean
  selector?: string
  extractMode?: MonitorExtractMode
}

/** `POST /api/monitor/create` reply. */
export interface MonitorCreateResponse {
  id: string
}

/** `GET /api/monitor/list` reply. */
export interface MonitorListResponse {
  monitors: Monitor[]
}

/** `GET /api/monitor/checks` reply. */
export interface MonitorChecksResponse {
  checks: Check[]
}

/** `POST /api/monitor/update` and `POST /api/monitor/delete` reply. */
export interface MonitorOkResponse {
  ok: boolean
}

/**
 * The intervals the create form offers as one-tap presets, in minutes.
 *
 * Hard bounds live in `MONITOR_LIMITS`; these are the values a person actually
 * picks, so the common case is one click and the number field is the fallback.
 */
export const MONITOR_INTERVAL_PRESETS: readonly number[] = [5, 15, 30, 60, 360, 720, 1440]

/** The bounds the create form enforces before a request is sent. */
export const MONITOR_LIMITS = {
  minIntervalMinutes: 1,
  /** One week. A longer interval is a cron job, not a monitor. */
  maxIntervalMinutes: 10080,
  defaultIntervalMinutes: 60,
  defaultHistoryLimit: 25,
  maxHistoryLimit: 100,
} as const
