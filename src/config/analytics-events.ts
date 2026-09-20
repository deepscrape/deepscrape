/**
 * Client analytics event names — the allow-list shared by the Angular app and the
 * Cloud Functions drain.
 *
 * Why this file exists: client events were free-form strings. `trackEvent("crawl_strted")`
 * (typo) landed in `analytics_events` verbatim and minted a NEW counter key
 * (`clientEvents.crawl_strted`) in `metrics_daily`/`metrics_hourly` that nothing ever
 * reads, silently and permanently — the panels are built from known keys, so a typo is
 * invisible from both ends. Same reasoning as `redis-keys.ts`: one declaration point so
 * the set is auditable, imported by both tsconfig graphs, dependency-free.
 *
 * To add an event: add it here, then emit it. Anything not listed is rejected by the
 * drain (kept as a fact for audit, counted under `unknown`).
 *
 * Server facts (`guest_created`, `user_registered`, `login_succeeded`, payment facts)
 * are written by triggers, never by the client, so they are not gated by this list.
 */
export const CLIENT_ANALYTICS_EVENTS = [
  // Navigation / exposure
  "page_view",
  "pricing_viewed",
  // Intent
  "signup_completed",
  "contact_submitted",
  "crawl_started",
  "crawl_completed",
  "crawl_failed",
  // Product surface (emitted by the service or surface that owns the action)
  "crawlpack_created",
  "machine_deployed",
  "machine_stopped",
  "org_created",
  "invitation_accepted",
  "api_key_created",
  "checkout_started",
  // System / state
  "login_attempt",
  "logout",
  "passkey_added",
  "session_revoked",
] as const

// Deliberately absent: `mfa_enabled` and `mfa_disabled`. Neither is a client event.
// MFA adoption is a server-side fact (`multiFactor.enrolledFactors` on the user
// document) and turning it off is routed through the `notifyMfaRiskEvent` callable,
// which owns its own risk pipeline in `gfunctions/sessions.ts`. Both were listed
// here before and emitted by nothing — exactly the drift this file exists to stop.

export type ClientAnalyticsEvent = typeof CLIENT_ANALYTICS_EVENTS[number]

/** Counter key used for anything off the allow-list, so typos stay one bounded bucket. */
export const UNKNOWN_CLIENT_ANALYTICS_EVENT = "unknown"

const CLIENT_ANALYTICS_EVENT_SET: ReadonlySet<string> = new Set(CLIENT_ANALYTICS_EVENTS)

/**
 * Whether a client-reported name is on the allow-list.
 *
 * @param {unknown} name Value straight off the wire (untrusted).
 * @return {boolean} True only for an exact allow-list match.
 */
export const isClientAnalyticsEvent = (name: unknown): name is ClientAnalyticsEvent =>
  typeof name === "string" && CLIENT_ANALYTICS_EVENT_SET.has(name)

/**
 * Map an untrusted client name onto a bounded event name.
 *
 * @param {unknown} name Value straight off the wire (untrusted).
 * @return {string} The allow-listed name, or `unknown` when it is not one.
 */
export const normalizeClientAnalyticsEvent = (name: unknown): string =>
  isClientAnalyticsEvent(name) ? name : UNKNOWN_CLIENT_ANALYTICS_EVENT
