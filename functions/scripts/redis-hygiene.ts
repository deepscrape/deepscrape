/* eslint-disable max-len */
/**
 * Redis key hygiene audit.
 *
 * Every key in this app must be declared in `src/config/redis-keys.ts` with a
 * TTL or an explicit bound. Two keys (`guestfp:*` and `analytics:events`) were
 * previously written with no expiry and grew without limit, which is the failure
 * this audit exists to catch before Redis starts evicting.
 *
 * Read-only by construction: it issues `DBSIZE`, `LLEN`, `SCAN`, `TTL`, and
 * `ZCARD` only.
 *
 * Usage:
 *   npx tsx functions/scripts/redis-hygiene.ts
 *   npx tsx functions/scripts/redis-hygiene.ts --samples=50
 */

import {
  ANALYTICS_EVENTS_KEY,
  CLIENT_EVENT_LIST_MAX,
  ONLINE_GUESTS_KEY,
  ONLINE_USERS_KEY,
  REDIS_NAMESPACE,
} from "../../src/config/redis-keys"

/**
 * The minimal Redis surface the audit needs, so it can be driven by a fake in
 * tests without constructing a real client.
 */
export type AuditRedis = {
  dbsize: () => Promise<number>
  llen: (key: string) => Promise<number>
  zcard: (key: string) => Promise<number>
  ttl: (key: string) => Promise<number>
  scan: (cursor: string | number, options: { match: string, count: number }) => Promise<[string | number, string[]]>
}

export type KeyPrefixReport = {
  /** SCAN pattern used, e.g. `session:*`. */
  pattern: string
  sampled: number
  /** Sampled keys reporting TTL -1 (present, never expires). */
  withoutExpiry: number
  /** Sampled keys reporting TTL -2 (already gone). */
  vanished: number
  /** Shortest TTL seen among the sampled keys, in seconds (null when none). */
  minTtlSeconds: number | null
  worstOffenders: string[]
}

export type HygieneReport = {
  dbSize: number
  analyticsBacklog: number
  analyticsBacklogLimit: number
  analyticsBacklogOverLimit: boolean
  presenceUsers: number
  presenceGuests: number
  prefixes: KeyPrefixReport[]
  /** Prefix + key for every sampled key that has no expiry, capped at 20. */
  unboundedKeys: string[]
}

/**
 * Worst-case sample size per prefix. Sampling at most this many keys keeps the
 * audit to a bounded number of round-trips on a large database.
 */
export const DEFAULT_SAMPLE_SIZE = 25

/**
 * The one key with no TTL that is allowed to exist, because it is a list with a
 * hard `LTRIM` ceiling applied on every write rather than an expiry.
 */
const ALLOWED_WITHOUT_TTL: ReadonlySet<string> = new Set([ANALYTICS_EVENTS_KEY])

/** Every prefix declared in `redis-keys.ts`, as a SCAN pattern. */
export const EXPECTED_PREFIXES: readonly string[] = [
  "session:*",
  "revoked:*",
  "signed-out:*",
  "auth:session:revoked:*",
  "session-access:*",
  "memberships:*",
  "user:*",
  "guest:*",
  "guestfp:*",
  "guestip:*",
  "ipintel:v2:*",
  "verification:*",
  "trusted:*",
  "rate_verification:*",
  "security:device-mismatch:*",
  "alert-notify:*",
  "rateLimit:*",
  "apiRateLimit:*",
  "functionsRateLimit:*",
  "authRateLimit*",
  "eventRateLimit*",
  ANALYTICS_EVENTS_KEY,
]

/**
 * Scan one page and report TTL coverage for the sampled keys.
 *
 * @param {AuditRedis} redis - Client used for SCAN and TTL.
 * @param {string} pattern - SCAN glob, e.g. `session:*`.
 * @param {number} sampleSize - Maximum keys to inspect from the page.
 * @return {Promise<KeyPrefixReport>} TTL coverage for the sampled keys.
 */
export async function auditPrefix(
  redis: AuditRedis,
  pattern: string,
  sampleSize: number,
): Promise<KeyPrefixReport> {
  const [, keys] = await redis.scan(0, {match: pattern, count: sampleSize})
  const sample = keys.slice(0, sampleSize)

  let withoutExpiry = 0
  let vanished = 0
  let minTtlSeconds: number | null = null
  const worstOffenders: string[] = []

  for (const key of sample) {
    let ttl: number
    try {
      ttl = await redis.ttl(key)
    } catch {
      // A key can disappear between SCAN and TTL; treat as already drained.
      vanished += 1
      continue
    }

    if (ttl === -2) {
      vanished += 1
      continue
    }
    if (ttl === -1) {
      if (!ALLOWED_WITHOUT_TTL.has(key)) {
        withoutExpiry += 1
        if (worstOffenders.length < 5) {
          worstOffenders.push(key)
        }
      }
      continue
    }
    if (minTtlSeconds === null || ttl < minTtlSeconds) {
      minTtlSeconds = ttl
    }
  }

  return {
    pattern,
    sampled: sample.length,
    withoutExpiry,
    vanished,
    minTtlSeconds,
    worstOffenders,
  }
}

/**
 * Run the full audit across every expected prefix plus the capped analytics list.
 *
 * @param {AuditRedis} redis - Client used for the read-only audit commands.
 * @param {object} [options] - Overrides for the default prefix list and sampling.
 * @param {string[]} [options.prefixes] - Prefixes to audit instead of EXPECTED_PREFIXES.
 * @param {number} [options.sampleSize] - Keys sampled per prefix.
 * @return {Promise<HygieneReport>} The assembled report.
 */
export async function auditRedisKeys(
  redis: AuditRedis,
  options: { prefixes?: readonly string[], sampleSize?: number } = {},
): Promise<HygieneReport> {
  const prefixes = options.prefixes ?? EXPECTED_PREFIXES
  const sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE

  const [dbSize, analyticsBacklog, presenceUsers, presenceGuests] = await Promise.all([
    redis.dbsize(),
    redis.llen(ANALYTICS_EVENTS_KEY),
    redis.zcard(ONLINE_USERS_KEY),
    redis.zcard(ONLINE_GUESTS_KEY),
  ])

  const reports: KeyPrefixReport[] = []
  const unboundedKeys: string[] = []
  for (const pattern of prefixes) {
    const report = await auditPrefix(redis, pattern, sampleSize)
    reports.push(report)
    for (const key of report.worstOffenders) {
      if (unboundedKeys.length < 20) {
        unboundedKeys.push(`${pattern} -> ${key}`)
      }
    }
  }

  return {
    dbSize,
    analyticsBacklog,
    analyticsBacklogLimit: CLIENT_EVENT_LIST_MAX,
    analyticsBacklogOverLimit: analyticsBacklog > CLIENT_EVENT_LIST_MAX,
    presenceUsers,
    presenceGuests,
    prefixes: reports,
    unboundedKeys,
  }
}

/**
 * Render the report and return the process exit code.
 *
 * Fails the run when any sampled key has no expiry, or when the analytics list
 * has exceeded its ingress cap — both mean a regression in the writer, not noise.
 *
 * @param {HygieneReport} report - Report produced by `auditRedisKeys`.
 * @return {Object} Rendered text and the intended exit code.
 */
export const renderReport = (report: HygieneReport): { text: string, exitCode: number } => {
  const lines: string[] = []
  lines.push(`Redis hygiene audit (namespace: ${REDIS_NAMESPACE})`)
  lines.push(`  DBSIZE: ${report.dbSize}`)
  lines.push(
    `  ${ANALYTICS_EVENTS_KEY}: ${report.analyticsBacklog} / ${report.analyticsBacklogLimit}` +
    (report.analyticsBacklogOverLimit ? "  <-- OVER LIMIT" : ""),
  )
  lines.push(`  ${ONLINE_USERS_KEY}: ${report.presenceUsers}`)
  lines.push(`  ${ONLINE_GUESTS_KEY}: ${report.presenceGuests}`)
  lines.push("")
  lines.push("  pattern                              sampled  no-expiry  min-ttl")
  for (const prefix of report.prefixes) {
    lines.push(
      `  ${prefix.pattern.padEnd(36)} ${String(prefix.sampled).padStart(7)} ` +
      `${String(prefix.withoutExpiry).padStart(10)} ` +
      `${(prefix.minTtlSeconds === null ? "-" : `${prefix.minTtlSeconds}s`).padStart(8)}`,
    )
  }

  let exitCode = 0
  if (report.unboundedKeys.length > 0) {
    lines.push("")
    lines.push("  Keys without an expiry (should not happen):")
    for (const entry of report.unboundedKeys) {
      lines.push(`    ${entry}`)
    }
    exitCode = 1
  }
  if (report.analyticsBacklogOverLimit) {
    exitCode = 1
  }

  return {text: lines.join("\n"), exitCode}
}
