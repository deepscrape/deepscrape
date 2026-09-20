/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
import { HttpsError } from "firebase-functions/v2/https"
// ponytail: push-token callables now metered per UID. Aliased — no call site
// changes. sendTestNotification in particular was a free way to spam your own
// devices (and burn FCM quota) in a loop.
import { guardedOnCall as onCall } from "../infrastructure/callable-limiter"
import { z } from "zod"
import { validateCallableData } from "../infrastructure/validate"
import {
  notificationTokensRef,
  removeNotificationToken,
  saveNotificationToken,
  sendToUser,
} from "../domain/notifications/tokens"

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
