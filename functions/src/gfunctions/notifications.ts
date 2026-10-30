/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
import { randomUUID } from "node:crypto"
import { FieldValue } from "firebase-admin/firestore"
import { HttpsError } from "firebase-functions/v2/https"
// ponytail: push-token callables now metered per UID. Aliased — no call site
// changes. sendTestNotification in particular was a free way to spam your own
// devices (and burn FCM quota) in a loop.
import { guardedOnCall as onCall } from "../infrastructure/callable-limiter"
import { z } from "zod"
import { db } from "../app/config"
import { validateCallableData } from "../infrastructure/validate"
import {
  notificationTokensRef,
  removeNotificationToken,
  saveNotificationToken,
  sendToUser,
} from "../domain/notifications/tokens"
import { resolveActorSessionAccess } from "./sessions"

const tokenSchema = z.string().min(20).max(4096)

const registerSchema = z.object({
  token: tokenSchema,
  platform: z.string().max(60).optional(),
  // The client passes its own UA: the callable request object does not expose the
  // browser UA in a stable shape across the v2 callable transports.
  userAgent: z.string().max(300).optional(),
  enabled: z.boolean().optional(),
})

/**
 * Register (or re-enable) a web-push token for the calling user.
 */
export const registerNotificationToken = onCall(
  {
    cors: true,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const data = validateCallableData(registerSchema, request.data)
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    try {
      const id = await saveNotificationToken(auth.uid, data.token, {
        platform: data.platform || "web",
        userAgent: data.userAgent || "",
        enabled: data.enabled,
      })
      return { success: true, id }
    } catch (error) {
      console.error("❌ Error registering notification token:", error)
      throw new Error("Failed to register notification token")
    }
  },
)

/**
 * Remove a web-push token, e.g. when the user turns push off on one device.
 */
export const unregisterNotificationToken = onCall(
  {
    cors: true,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const { token } = validateCallableData(z.object({ token: tokenSchema }), request.data)
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    try {
      const removed = await removeNotificationToken(auth.uid, token)
      return { success: true, removed }
    } catch (error) {
      console.error("❌ Error unregistering notification token:", error)
      throw new Error("Failed to unregister notification token")
    }
  },
)

/**
 * List the calling user's registered devices (never the raw tokens).
 */
export const getMyNotificationTokens = onCall(
  {
    cors: true,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    try {
      const snapshot = await notificationTokensRef(auth.uid).limit(50).get()
      return {
        count: snapshot.size,
        devices: snapshot.docs.map((doc) => {
          const data = doc.data() as { platform?: string, enabled?: boolean, updatedAt?: { toDate?: () => Date } }
          return {
            id: doc.id,
            platform: data.platform || "web",
            enabled: data.enabled !== false,
            updatedAt: data.updatedAt?.toDate?.().toISOString() || null,
          }
        }),
      }
    } catch (error) {
      console.error("❌ Error listing notification tokens:", error)
      throw new Error("Failed to list notification tokens")
    }
  },
)

/**
 * Send a test push to the caller's own devices.
 *
 * Self-only by construction (the uid comes from the verified auth context), so it
 * needs no admin claim and cannot be used to deliver to another user.
 */
export const sendTestNotification = onCall(
  {
    cors: true,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const auth = request.auth

    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    try {
      const result = await sendToUser(auth.uid, {
        title: "deepscrape",
        body: "Push notifications are live for this device.",
        link: "/dashboard",
        data: { kind: "test" },
      })
      return { success: true, ...result }
    } catch (error) {
      console.error("❌ Error sending test notification:", error)
      throw new Error("Failed to send test notification")
    }
  },
)

// A broadcast writes one alert document per user; delivery stays in the alert
// fan-out so throttling, opt-out and channel choice keep a single owner.
const BROADCAST_MAX_USERS = 5000

const broadcastSchema = z.object({
  title: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(500),
  // Same-origin path only: this value reaches the service worker's
  // `clients.navigate`, where an absolute URL would leave the app.
  link: z.string().trim().regex(/^\/[^\s]*$/).max(300).optional(),
})

/**
 * Send a platform notice to every user (bell document + push via the fan-out).
 *
 * There is no audience parameter: the collection scan decides who receives it.
 * The admin check reads the verified session, never the request body.
 * @param {*} request The callable request.
 * @return {*} How many users were written.
 */
export const adminBroadcastNotification = onCall(
  {
    cors: true,
    region: "us-central1",
  },
  async (request) => {
    const data = validateCallableData(broadcastSchema, request.data)
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const access = await resolveActorSessionAccess(request.auth)
    if (access.role !== "admin" && access.role !== "superadmin") {
      throw new HttpsError("permission-denied", "Platform admin required")
    }

    // shortcut: one alert doc per user, so the fan-out runs per user and the
    // scan stops at BROADCAST_MAX_USERS. Switch to an FCM topic plus a single
    // announcement document when the audience makes that cost matter.
    const snapshot = await db
      .collection("users")
      .limit(BROADCAST_MAX_USERS)
      .get()

    const broadcastId = randomUUID()
    let batch = db.batch()
    let written = 0

    for (const user of snapshot.docs) {
      batch.set(db.doc(`users/${user.id}/alerts/broadcast-${broadcastId}`), {
        category: "broadcast",
        title: data.title,
        message: data.message,
        ...(data.link ? { link: data.link } : {}),
        createdAt: FieldValue.serverTimestamp(),
        read: false,
      })
      written += 1
      if (written % 400 === 0) {
        await batch.commit()
        batch = db.batch()
      }
    }

    await batch.commit()
    return { sent: written }
  },
)
