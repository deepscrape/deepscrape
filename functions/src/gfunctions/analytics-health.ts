/* eslint-disable max-len */
/**
 * Analytics pipeline health check.
 *
 * Why this exists: guest creation stopped dead for two days (a consent gate shipped while
 * the only client call that could mint a guest was never made) and nothing said so — the
 * outage was discovered by opening the admin panel and reading zeros. A metric that must
 * never be zero needs a check that says so, not a human who happens to look.
 *
 * The incident lands in `billing_incidents`, which the admin notification bell already
 * lists and acknowledges, so this needs no new collection, UI, or alert channel.
 *
 * ponytail: yesterday against the median of the seven days before it. A whole complete day
 * avoids the false positive that comparing a half-finished day would give, and the median
 * ignores a single freak day. Move to a rolling average with a confidence band if false
 * positives ever show up.
 */
import {onSchedule} from "firebase-functions/v2/scheduler"
import {Timestamp} from "firebase-admin/firestore"
import {db} from "../app/config"

/** Alert when the subject day is under this share of the baseline median. */
const ALERT_RATIO = 0.1
/** Days used for the baseline median (the seven complete days before the subject day). */
const BASELINE_DAYS = 7

/**
 * UTC day key, `daysAgo` days before `from`.
 *
 * @param {Date} from Reference date.
 * @param {number} daysAgo How many days back to step.
 * @return {string} `YYYY-MM-DD`.
 */
const dayKey = (from: Date, daysAgo: number): string =>
  new Date(from.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString().split("T")[0]

/**
 * Read `newGuests` for a day, or null when the document does not exist.
 *
 * @param {string} date `YYYY-MM-DD`.
 * @return {Promise<number | null>} New guests that day.
 */
const readNewGuests = async (date: string): Promise<number | null> => {
  const snap = await db.doc(`metrics_daily/${date}`).get()
  if (!snap.exists) {
    return null
  }
  const data = snap.data() as {newGuests?: number} | undefined
  return Number(data?.newGuests || 0)
}

/**
 * Compare yesterday's guest creation against the preceding week and raise an incident
 * when it looks stalled. Skips quietly while there is no baseline to compare against
 * (a new deployment, or genuinely no traffic yet) so it cannot cry wolf on day one.
 *
 * @return {Promise<void>} Resolves when the check has finished or failed softly.
 */
export const checkAnalyticsPipelineHealth = onSchedule(
  {
    schedule: "30 6 * * *",
    timeZone: "UTC",
    region: "us-central1",
  },
  async () => {
    try {
      const now = new Date()
      const subjectDay = dayKey(now, 1)
      const subjectGuests = await readNewGuests(subjectDay)
      if (subjectGuests === null) {
        console.warn(`analytics-health: no metrics_daily/${subjectDay} to check`)
        return
      }

      const baseline: number[] = []
      for (let offset = 2; offset <= BASELINE_DAYS + 1; offset++) {
        const value = await readNewGuests(dayKey(now, offset))
        if (value !== null) {
          baseline.push(value)
        }
      }
      if (!baseline.length) {
        return
      }

      baseline.sort((a, b) => a - b)
      const median = baseline[Math.floor(baseline.length / 2)]
      if (median <= 0) {
        return
      }
      if (subjectGuests > median * ALERT_RATIO) {
        return
      }

      // Order-by-then-filter in code: an equality + orderBy pair would need a composite
      // index, and this collection is small enough that twenty rows is free.
      const recent = await db.collection("billing_incidents")
        .orderBy("createdAt", "desc")
        .limit(20)
        .get()
      const alreadyOpen = recent.docs.some((doc) => {
        const data = doc.data() as {source?: string; acknowledged?: boolean}
        return data.source === "analytics-health" && data.acknowledged !== true
      })
      if (alreadyOpen) {
        return
      }

      await db.collection("billing_incidents").add({
        type: "error",
        severity: "error",
        source: "analytics-health",
        title: "Visitor tracking may have stopped",
        message: `${subjectDay} recorded ${subjectGuests} new guests against a ${BASELINE_DAYS}-day median of ${median}. Check the consent gate, the guest tracker and the client-event drain.`,
        metadata: {subjectDay, subjectGuests, median, baselineDays: BASELINE_DAYS},
        acknowledged: false,
        createdAt: Timestamp.now(),
      })
      console.error(`analytics-health: ${subjectDay} had ${subjectGuests} new guests vs median ${median}`)
    } catch (error) {
      console.error("analytics-health check failed:", error)
    }
  },
)
