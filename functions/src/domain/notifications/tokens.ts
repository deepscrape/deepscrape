/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
import { createHash } from "node:crypto"
import { Timestamp } from "firebase-admin/firestore"
import { getMessaging } from "firebase-admin/messaging"
import { db } from "../../app/config"

/**
 * Web-push notification tokens.
 *
 * A user can be signed in on several browsers, so tokens live in a subcollection
 * (`users/{uid}/notificationTokens/{id}`) rather than a single field on the user
 * doc — a stale token on one device must not evict a live one on another.
 */

// Raw FCM tokens are ~160+ chars and are not valid Firestore document ids, so the
// id is a truncated SHA-256 of the token. The raw token is still stored in the body
// because it is what `sendEachForMulticast` needs.
export const tokenDocId = (token: string): string =>
  createHash("sha256").update(token).digest("hex").slice(0, 40)

export type NotificationTokenMeta = {
  platform: string
  userAgent: string
  enabled?: boolean
}

export const notificationTokensRef = (uid: string) =>
  db.collection("users").doc(uid).collection("notificationTokens")

/**
 * saveNotificationToken
 * @param {*} uid
 * @param {*} token
 * @param {*} meta
 */
export async function saveNotificationToken(
  uid: string,
  token: string,
  meta: NotificationTokenMeta,
): Promise<string> {
  const id = tokenDocId(token)
  const now = Timestamp.now()
  const ref = notificationTokensRef(uid).doc(id)

  // Merge so re-enabling on the same device keeps createdAt (it is a first-seen
  // marker, not a last-seen one).
  const existing = await ref.get()
  await ref.set({
    token,
    platform: meta.platform.slice(0, 60),
    userAgent: meta.userAgent.slice(0, 300),
    enabled: meta.enabled !== false,
    updatedAt: now,
    ...(existing.exists ? {} : { createdAt: now }),
  }, { merge: true })

  return id
}

/**
 * removeNotificationToken
 * @param {*} uid
 * @param {*} token
 */
export async function removeNotificationToken(uid: string, token: string): Promise<boolean> {
  const ref = notificationTokensRef(uid).doc(tokenDocId(token))
  const existing = await ref.get()
  if (!existing.exists) return false
  await ref.delete()
  return true
}

export type PushPayload = {
  title: string
  body: string
  /** Deep-link the notification opens. Resolved against the app origin. */
  link?: string
  /** Arbitrary string data delivered to the client handler. */
  data?: Record<string, string>
}

export type SendResult = {
  attempted: number
  sent: number
  failed: number
  pruned: string[]
}

/**
 * Send to every enabled device a user has, pruning tokens FCM reports as dead.
 *
 * Pruning matters more than the send: without it a user who clears site data
 * leaves a permanent failure on every future broadcast.
 *
 * @param {string} uid Owner of the tokens.
 * @param {PushPayload} payload Notification content.
 * @return {Promise<SendResult>} Counts plus the token ids that were pruned.
 */
/**
 * sendToUser
 * @param {*} uid
 * @param {*} payload
 */
export async function sendToUser(uid: string, payload: PushPayload): Promise<SendResult> {
  const snapshot = await notificationTokensRef(uid).where("enabled", "==", true).limit(50).get()
  const records = snapshot.docs
    .map((doc) => ({ id: doc.id, token: (doc.data() as { token?: string }).token }))
    .filter((entry): entry is { id: string, token: string } => !!entry.token)

  if (!records.length) return { attempted: 0, sent: 0, failed: 0, pruned: [] }

  const response = await getMessaging().sendEachForMulticast({
    tokens: records.map((entry) => entry.token),
    notification: { title: payload.title, body: payload.body },
    data: payload.data,
    webpush: {
      notification: {
        title: payload.title,
        body: payload.body,
        icon: "/icons/icon-192x192.png",
      },
      fcmOptions: payload.link ? { link: payload.link } : undefined,
    },
  })

  // `registration-token-not-registered` / `invalid-argument` mean the token is
  // permanently dead; a transient `unavailable` must NOT prune a live device.
  const deadCodes = new Set(["messaging/registration-token-not-registered", "messaging/invalid-argument"])
  const pruned: string[] = []

  await Promise.all(response.responses.map(async (result, index) => {
    if (result.success) return
    if (!deadCodes.has(result.error?.code || "")) return
    const record = records[index]
    if (!record) return
    pruned.push(record.id)
    await notificationTokensRef(uid).doc(record.id).delete()
  }))

  return {
    attempted: records.length,
    sent: response.successCount,
    failed: response.failureCount,
    pruned,
  }
}
