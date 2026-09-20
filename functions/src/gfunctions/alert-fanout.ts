/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
import { onDocumentCreated } from "firebase-functions/v2/firestore"
import { auth as adminAuth, db, dbName } from "../app/config"
import { redisEval } from "../app/cacheConfig"
import { env, functionsEnvJson } from "../config/env"
import {
  ALERT_NOTIFY_MAX_PER_WINDOW,
  ALERT_NOTIFY_WINDOW_SECONDS,
  alertNotifyKey,
} from "../../../src/config/redis-keys"
import { FIXED_WINDOW_INCREMENT } from "../../../src/config/redis-scripts"
import { AlertDocData, presentAlert } from "../domain/notifications/alert-presentation"
import { sendToUser } from "../domain/notifications/tokens"
import { renderEmail, renderEmailText, sendEmail } from "../infrastructure/email"

const DATABASE_NAME = dbName || "easyscrape"

/**
 * Outbound fan-out for security alerts: email + web push.
 *
 * Why a trigger instead of sending from the writer: the writers run on hot paths
 * (login, device trust). A Resend round-trip there adds ~400 ms to a sign-in, it
 * has to be awaited (Cloud Functions can reclaim background work after the
 * response), and every new alert type would re-implement the fan-out. Listening on
 * the collection means a writer only has to *write the alert*, and one code path
 * owns throttle, opt-out, rendering and delivery.
 *
 * DO NOT write to `users/{uid}/alerts` from this function. It is the collection
 * this trigger fires on, and a write here would recursively invoke itself.
 */
export const onSecurityAlertCreated = onDocumentCreated(
  {
    document: "users/{uid}/alerts/{alertId}",
    database: DATABASE_NAME,
    region: "us-central1",
    secrets: [functionsEnvJson],
  },
  /**
   * callback
   * @param {*} event
   */
  async (event) => {
    const uid = String(event.params.uid || "").trim()
    const data = event.data?.data() as AlertDocData | undefined
    if (!uid || !data) return

    const category = typeof data.category === "string" && data.category.trim() ?
      data.category.trim() : "generic"

    try {
      // Cheapest check first, and the only thing standing between a
      // country-hopping VPN user and one paid email per sign-in.
      if (!await withinNotifyBudget(uid, category)) return

      const presentation = presentAlert(data)
      if (!presentation.channels.push && !presentation.channels.email) return

      const [userSnap, recipient] = await Promise.all([
        db.doc(`users/${uid}`).get(),
        promiseOrNull(adminAuth.getUser(uid)),
      ])

      // Single opt-out enforcement point. The alert document itself is never
      // suppressed — it still reaches the bell — only the outbound channels.
      const notifications = userSnap.data()?.notifications as { securityAlerts?: boolean } | undefined
      if (notifications?.securityAlerts === false) return

      const to = recipient?.email || ""
      const securityUrl = `${env.APP_ORIGIN}/settings/security`

      const work: Promise<unknown>[] = []

      if (presentation.channels.push) {
        work.push(sendToUser(uid, {
          title: presentation.pushTitle,
          body: presentation.pushBody,
          link: securityUrl,
          data: { category, alertId: String(event.params.alertId || "") },
        }))
      }

      if (presentation.channels.email && presentation.email && to) {
        const { subject, content } = presentation.email
        work.push(sendEmail({
          to,
          subject,
          html: renderEmail(content),
          text: renderEmailText(content),
        }))
      }

      // Independent channels, so a slow email provider must not delay the push.
      const results = await Promise.all(work)
      console.log(`Security alert fan-out for ${uid} (${category}):`, JSON.stringify(results))
    } catch (error) {
      // Swallowed on purpose. Alert documents are never removed, so the bell
      // still shows the alert; throwing would make Cloud Functions retry the
      // event and deliver the notification a second time.
      console.error(`Security alert fan-out failed for ${uid} (${category}):`, error)
    }
  },
)

// `null` instead of a rejection, so one failure cannot abort a Promise.all.
const promiseOrNull = async <T>(promise: Promise<T>): Promise<T | null> => {
  try {
    return await promise
  } catch {
    return null
  }
}

/**
 * Fixed-window budget, one window per (user, category).
 *
 * Fails OPEN: if Redis is unavailable the notification is still delivered. The
 * budget protects quota and inbox reputation, which is worth less than telling a
 * user their account was accessed from somewhere new.
 *
 * @param {string} uid Alert owner.
 * @param {string} category Alert category used as the budget bucket.
 * @return {Promise<boolean>} True when this alert may notify outbound channels.
 */
const withinNotifyBudget = async (uid: string, category: string): Promise<boolean> => {
  try {
    const [count] = await redisEval<[number | null, number]>(
      FIXED_WINDOW_INCREMENT,
      [alertNotifyKey(uid, category)],
      [ALERT_NOTIFY_WINDOW_SECONDS],
    )
    // The no-op Redis client answers `[null, ...]`, which is not a number and
    // therefore allows the send — dev/emulator keeps working without Redis.
    if (typeof count !== "number") return true
    return count <= ALERT_NOTIFY_MAX_PER_WINDOW
  } catch (error) {
    console.warn(`Alert notify budget check failed for ${uid}:`, error)
    return true
  }
}
