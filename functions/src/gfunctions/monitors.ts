/* eslint-disable object-curly-spacing */
/**
 * The monitor drain — the scheduled half of page monitoring.
 *
 * Why this runs INLINE rather than through QStash
 * ----------------------------------------------
 * The crawl-job path publishes one QStash message per target, and that is right
 * there: a job is user-initiated, its fan-out is up to 50 targets that must
 * interleave and retry individually, and its delivery endpoint lives on the BFF
 * where the QStash signature IS the authentication.
 *
 * A monitor drain differs on all three points, and each one argues for inline:
 *
 *  - It is a BOUNDED batch the scheduler itself owns (`MONITOR_DRAIN_BATCH`),
 *    not an unbounded fan-out, so there is nothing for a queue to interleave.
 *  - It needs no per-message retry: the next run IS the retry, because every
 *    run re-queries for what is due. A message that failed would only duplicate
 *    work the next tick already does.
 *  - The production BFF has no `QSTASH_*` environment, so publishing to a
 *    delivery endpoint on the BFF would produce deliveries the BFF refuses with
 *    a 401 — work that moves nowhere and reports nothing. Degrading here means
 *    never taking that path at all, which is why QStash is not imported by this
 *    file: there is no configuration in which this drain quietly stops.
 *
 * The scheduled runtime is also the process that already holds the worker
 * credentials (`FUNCTIONS_ENV_JSON` binds `WEBRAIN_MCP_URL`), so the call goes
 * straight to webrain with no third party in the path.
 *
 * The bound, and why it is a constant
 * ----------------------------------
 * `MONITOR_DRAIN_BATCH` is the most monitors one run may claim, and each claim
 * is one worker request against a SHARED pool. It is a constant in the domain
 * module rather than a literal here so the ceiling on "how much of the pool can
 * the scheduler take in one burst" is stated once, next to the interval bounds
 * that decide how often it happens.
 *
 * A run that outlives its own five-minute slot is safe rather than prevented:
 * `claimDueMonitors` advances each monitor's due-time BEFORE the check, so an
 * overlapping run cannot claim the same monitor twice.
 */
import { onSchedule } from "firebase-functions/v2/scheduler"
import { functionsEnvJson } from "../config/env"
import { MONITOR_DRAIN_BATCH } from "../domain/monitors.domain"
import { checkMonitor } from "../infrastructure/monitor-check"
import { claimDueMonitors } from "../infrastructure/monitor.store"

/**
 * Checks every monitor whose turn it is, up to the per-run bound.
 *
 * Per-monitor failures are contained: `checkMonitor` records an error row
 * rather than throwing, so one unreachable page cannot abandon the rest of the
 * batch. The loop is intentionally sequential — `MONITOR_DRAIN_BATCH` small
 * requests to one worker, in order, is the shape that cannot stampede it.
 */
export const drainDueMonitors = onSchedule(
  {
    // Every five minutes: the floor of `MONITOR_MIN_INTERVAL_MINUTES`, so a
    // monitor at the shortest interval is checked once per run and no faster.
    schedule: "*/5 * * * *",
    timeZone: "UTC",
    region: "us-central1",
    // The run's own ceiling is one scheduling period; a longer one would
    // overlap the next tick's run, which the claim ordering tolerates but
    // nothing needs.
    timeoutSeconds: 300,
    memory: "256MiB",
    // Without this binding the process has no WEBRAIN_MCP_URL and every check
    // would be recorded as "the worker is unreachable" — a monitor that looks
    // broken while the fault is a missing secret.
    secrets: [functionsEnvJson],
  },
  /**
   * callback
   * @return {Promise<void>} Resolves once the batch has been attempted.
   */
  async () => {
    const now = Date.now()

    let claimed: Awaited<ReturnType<typeof claimDueMonitors>> = []
    try {
      claimed = await claimDueMonitors(now, MONITOR_DRAIN_BATCH)
    } catch (error) {
      // The claim query itself failed (missing index, permissions, quota).
      // Logged and returned: there is nothing to check, and throwing would only
      // add a retry of the same failing query.
      console.error("monitor drain: claim failed:", error)
      return
    }

    if (!claimed.length) {
      return
    }

    console.log(`monitor drain: checking ${claimed.length} monitor(s)`)

    for (const monitor of claimed) {
      await checkMonitor(monitor)
    }
  }
)
