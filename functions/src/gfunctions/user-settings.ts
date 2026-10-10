/* eslint-disable object-curly-spacing */
/**
 * The settings write path: the scrape provider, and where AI credentials come
 * from.
 *
 * Why callables rather than more HTTP routes
 * -----------------------------------------
 * These are per-user preferences, not scraping work. A callable carries the
 * caller's identity, so the uid is never taken from the request body — a route
 * that reads a uid parameter is how one account writes another account's
 * settings. Nothing here accepts a target uid.
 *
 * The entitlement check is the same rule the HTTP routes enforce
 * (`getBillingAccessMode`), applied in one place so a preference cannot be
 * stored
 * that the request path would then refuse. Storing an unusable choice is worse
 * than rejecting it: the user sets it, sees no error, and gets the fallback.
 *
 * SECURITY — read before this is deployed
 * ---------------------------------------
 * A user-supplied API key is stored at `users/{uid}/private/ai`. That path MUST
 * have Firestore rules denying all client reads and writes; only the Admin SDK
 * touches it. Until those rules exist, a stored key is readable by anything
 * that
 * can read the user's own documents, which is not an acceptable place for a
 * credential. Secret Manager is the better long-term home for these and is the
 * follow-up; Firestore is used here because the rules change and the callable
 * are
 * one concern, while a per-user Secret Manager provisioning path is another.
 *
 * No key value is ever returned, logged, or included in an error.
 * `getMySettings`
 * reports only WHICH vendors have a key — the ids, never the material — so the
 * UI
 * can render state without the value crossing the boundary a second time.
 */
import { HttpsError } from "firebase-functions/v2/https"
import { guardedOnCall as onCall } from "../infrastructure/callable-limiter"
import {
  db,
  getSecretFromManager,
  purgeSecretAndAllRevisions,
  upsertSecretValue,
} from "../app/config"
import { getBillingAccessMode } from "../domain/billing.domain"
import {
  readStoredProvider,
  writeStoredProvider,
} from "../infrastructure/scrape-provider.store"
import {
  isScrapeProviderId,
  selectableProviders,
} from "../domain/scrape-providers.domain"
import {
  type AiVendorId,
  availableVendors,
  isAiVendorId,
  isPlausibleApiKey,
} from "../domain/user-ai-settings.domain"

/** Shared options: every callable here is a small settings write. */
const OPTIONS = {
  cors: true,
  region: "us-central1",
  memory: "256MiB" as const,
}

const requireUid = (request: { auth?: { uid?: string } }): string => {
  const uid = request.auth?.uid
  if (!uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.")
  }
  return uid
}

/**
 * The caller's plan, read the same way `requirePaidAccess` reads it.
 *
 * Deliberately not cached between callables: a plan can change between two
 * settings writes, and a stale entitlement is how a downgraded account keeps a
 * paid feature.
 * @param {*} uid
 */
const accessModeOf = async (uid: string): Promise<string> => {
  const snapshot = await db
    .collection("users")
    .doc(uid)
    .collection("billing")
    .doc("current")
    .get()
  if (!snapshot.exists) {
    return getBillingAccessMode(undefined)
  }
  return getBillingAccessMode(snapshot.data())
}

/** `users/{uid}/private/ai` — see the SECURITY note above.
 * @param {*} uid
 * @return {*}
 */
const aiKeysRef = (uid: string) =>
  db.collection("users").doc(uid).collection("private").doc("ai")

/**
 * The vendor ids the caller has a key stored for.
 *
 * Returns ids only. The document's field names are the vendor ids, so the
 * presence of a field is the whole answer and the values are never touched.
 * @param {*} uid
 */
const mappedVendorIds = async (uid: string): Promise<AiVendorId[]> => {
  const snapshot = await aiKeysRef(uid).get()
  if (!snapshot.exists) {
    return []
  }
  const data = snapshot.data() ?? {}
  return Object.keys(data).filter(isAiVendorId)
}

/**
 * The caller's stored key for one vendor, or null.
 *
 * The ONLY place a stored key is read, and it sits beside the only place one is
 * written, so the write path and the request path cannot drift apart on the
 * document layout — a drift that would present as "my key does nothing" with no
 * error anywhere. The value is returned to the caller for one purpose: to be
 * placed in an upstream request header. It is never logged, never echoed, and
 * never included in any response.
 * @param {*} uid
 * @param {*} vendor
 */
export const readUserAiKey = async (
  uid: string,
  vendor: AiVendorId
): Promise<string | null> => {
  const snapshot = await aiKeysRef(uid).get()
  if (!snapshot.exists) {
    return null
  }

  const entry = (snapshot.data() ?? {})[vendor]

  // A STRING here is the legacy layout: the field value WAS the key. Migrate it
  // on read so an existing user keeps a working key without re-entering it, and
  // rewrite the field as metadata so this branch runs at most once per vendor.
  if (typeof entry === "string" && entry.length > 0) {
    await migrateLegacyKey(uid, vendor, entry)
    return entry
  }

  const secretPath = secretPathOf(entry)
  if (!secretPath) {
    return null
  }

  // A path that resolves to nothing means the secret was purged while the
  // metadata survived; report absence rather than an empty credential, so the
  // caller falls back to the platform key instead of sending an empty header.
  const value = await getSecretFromManager(secretPath)
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * The Secret Manager secret id for one user's key for one vendor.
 *
 * Deterministic, so a save and a later read agree without storing the name
 * twice, and scoped by uid so one account's secret is not reachable from
 * another's request. The uid comes from the verified token and never from a
 * request body, which is what makes the scoping real rather than decorative.
 * @param {*} uid
 * @param {*} vendor
 * @return {*}
 */
const aiKeySecretId = (uid: string, vendor: AiVendorId): string =>
  `ai-key-${uid}-${vendor}`

/** The secret path recorded as metadata, or null for any other shape.
 * @param {*} entry
 * @return {*}
 */
const secretPathOf = (entry: unknown): string | null => {
  if (!entry || typeof entry !== "object") {
    return null
  }
  const path = (entry as { secretPath?: unknown }).secretPath
  return typeof path === "string" && path.length > 0 ? path : null
}

/**
 * Move a legacy plaintext key into Secret Manager.
 *
 * Best-effort on purpose: the caller must still receive the key they already
 * stored even if the migration cannot run, so a failure is logged and the read
 * continues. The plaintext field is only overwritten AFTER the secret write
 * succeeds, so a failed migration cannot leave the account with no usable key.
 * @param {*} uid
 * @param {*} vendor
 * @param {*} value
 */
const migrateLegacyKey = async (
  uid: string,
  vendor: AiVendorId,
  value: string
): Promise<void> => {
  try {
    const secretPath = await upsertSecretValue(
      aiKeySecretId(uid, vendor),
      value
    )
    await aiKeysRef(uid).set(
      { [vendor]: { secretPath, updatedAt: Date.now() } },
      { merge: true }
    )
  } catch (error) {
    // The message only, and never the value: this catch exists so a migration
    // outage degrades to "still reads the old field", not to a lost key.
    console.error("AI key migration failed:", (error as Error).message)
  }
}

/**
 * Everything the settings UI needs, in one round trip.
 *
 * Composed server-side because the two halves share the same plan check; asking
 * the client to call twice would let it render one half against a plan the
 * other
 * half had already been refused under.
 */
export const getMySettings = onCall(OPTIONS, async (request) => {
  const uid = requireUid(request)
  const accessMode = await accessModeOf(uid)

  const storedProvider = await readStoredProvider(uid)
  const selectable = selectableProviders(accessMode, "crawl")
  const keyed = await mappedVendorIds(uid)

  return {
    accessMode,
    scrape: {
      stored: isScrapeProviderId(storedProvider) ? storedProvider : null,
      selectable: selectable.map((provider) => ({
        id: provider.id,
        labelKey: provider.labelKey,
        notes: provider.notes,
        capabilities: provider.capabilities,
      })),
    },
    ai: {
      vendors: availableVendors(accessMode, keyed).map((resolution) => ({
        id: resolution.vendor?.id ?? null,
        labelKey: resolution.vendor?.labelKey ?? null,
        allowed: resolution.allowed,
        source: resolution.source,
        refusal: resolution.refusal ?? null,
        hasKey: resolution.vendor ?
          keyed.includes(resolution.vendor.id) :
          false,
      })),
    },
  }
})

/**
 * Stores the caller's preferred scrape provider.
 *
 * Validated against the same catalogue the request path resolves from, so a
 * value
 * can only be stored if the resolver would select it. A stored value that
 * cannot
 * be selected is worse than a rejection: the user believes it took effect and
 * silently receives the fallback instead.
 */
export const setMyScrapeProvider = onCall(OPTIONS, async (request) => {
  const uid = requireUid(request)
  const providerId = (request.data as { provider?: unknown } | undefined)
    ?.provider

  if (!isScrapeProviderId(providerId)) {
    throw new HttpsError("invalid-argument", "Unknown scraping provider.")
  }

  const accessMode = await accessModeOf(uid)
  const selectable = selectableProviders(accessMode, "crawl")
  if (!selectable.some((provider) => provider.id === providerId)) {
    // One message for "not on your plan" and "not in the catalogue for this
    // route": the distinction is already in the catalogue, and telling a free
    // user
    // which paid provider exists would be advertising they did not ask for.
    throw new HttpsError(
      "permission-denied",
      "That provider is not available on your current plan."
    )
  }

  await writeStoredProvider(uid, providerId)
  return { stored: providerId }
})

/**
 * Stores a BYOK key for one vendor.
 *
 * The value is written and never echoed. The response reports only that the
 * vendor now has a key, so a caller cannot use this endpoint to read back a key
 * it wrote, and a proxy or log capturing the response captures no credential.
 */
export const setMyAiKey = onCall(OPTIONS, async (request) => {
  const uid = requireUid(request)
  const data = request.data as { vendor?: unknown; key?: unknown } | undefined
  // Bound to locals because `isAiVendorId(data?.vendor)` narrows the property
  // expression, not `data` itself — so `data.vendor` after the guard still
  // reads
  // as possibly-undefined to the compiler even
  // though the guard proved otherwise.
  const vendor = data?.vendor
  const key = data?.key

  if (!isAiVendorId(vendor)) {
    throw new HttpsError("invalid-argument", "Unknown AI vendor.")
  }
  if (!isPlausibleApiKey(key)) {
    // No value in the message, and none in any log line: it is a credential.
    throw new HttpsError(
      "invalid-argument",
      "That does not look like an API key."
    )
  }

  // The value goes to Secret Manager; Firestore keeps only WHERE it lives, so a
  // document read can no longer yield a credential. `merge` preserves the other
  // vendors' entries in the same document.
  const secretPath = await upsertSecretValue(
    aiKeySecretId(uid, vendor),
    key.trim()
  )

  await aiKeysRef(uid).set(
    { [vendor]: { secretPath, updatedAt: Date.now() } },
    { merge: true }
  )

  return { vendor, hasKey: true }
})

/**
 * Removes a BYOK key, returning the caller to the platform key or to nothing.
 *
 * A refusal is not possible here: removing a key is always allowed, including
 * on
 * a free plan, because it can only reduce what is being used.
 */
export const clearMyAiKey = onCall(OPTIONS, async (request) => {
  const uid = requireUid(request)
  const vendor = (request.data as { vendor?: unknown } | undefined)?.vendor

  if (!isAiVendorId(vendor)) {
    throw new HttpsError("invalid-argument", "Unknown AI vendor.")
  }

  const snapshot = await aiKeysRef(uid).get()
  if (!snapshot.exists) {
    return { vendor, hasKey: false }
  }

  // Destroy the value rather than merely forgetting its address: an
  // unreferenced secret version is still readable by anything holding secret
  // access, and the user asked for the key to be gone. A legacy plaintext entry
  // has no secret yet, so there is nothing to purge and the field delete below
  // is the whole removal.
  const secretPath = secretPathOf((snapshot.data() ?? {})[vendor])
  if (secretPath) {
    await purgeSecretAndAllRevisions(secretPath)
  }

  // Field deletion rather than a null value: a null would still read as "a key
  // is
  // present" to any presence check, including `mappedVendorIds` above.
  const { FieldValue } = await import("firebase-admin/firestore")
  await aiKeysRef(uid).update({ [vendor]: FieldValue.delete() })

  return { vendor, hasKey: false }
})

/** Notification preferences this callable may write. */
const WRITABLE_NOTIFICATION_PREFERENCES = ["spendCapEmail"] as const

type WritableNotificationPreference =
  (typeof WRITABLE_NOTIFICATION_PREFERENCES)[number]

/**
 * Narrows a caller-supplied preference key to the allowlist.
 *
 * An allowlist and not a passthrough: without it this callable would let a
 * caller write an arbitrary field into their own user document, which is a
 * privilege the client must not have.
 * @param {*} value Candidate key from the request body.
 * @return {boolean} True when the key may be written.
 */
const isWritableNotificationPreference = (
  value: unknown
): value is WritableNotificationPreference =>
  typeof value === "string" &&
  (WRITABLE_NOTIFICATION_PREFERENCES as readonly string[]).includes(value)

/**
 * The caller's notification preferences, with defaults applied.
 *
 * The default lives here, server-side and in one place, because the client
 * and the alert fan-out must agree on what "unset" means. `spendCapEmail`
 * defaults to FALSE: it is an opt-in, so an absent field is a user who never
 * asked for mail, not a user who asked and was ignored.
 * @param {*} request The callable request.
 * @return {Promise<*>} The preference bag.
 */
export const getMyNotificationPreferences = onCall(
  OPTIONS,
  async (request) => {
    const uid = requireUid(request)
    const snapshot = await db.collection("users").doc(uid).get()
    const stored = (snapshot.data()?.notifications as {
      preferences?: Record<string, unknown>
    } | undefined)?.preferences
    return {
      preferences: {
        spendCapEmail: stored?.spendCapEmail === true,
      },
    }
  }
)

/**
 * Stores one notification preference for the caller.
 *
 * `merge: true` is what makes this safe per-key: Firestore merges nested maps
 * field by field, so writing `spendCapEmail` cannot drop the caller's other
 * preferences, nor the `securityAlerts` and `emailNotifications` flags that
 * sit beside them in `notifications`. A whole-object replace would silently
 * discard everything the user had set through any other surface.
 *
 * The uid comes from the verified token ONLY, never the body.
 * @param {*} request The callable request.
 * @return {Promise<*>} The stored key and value.
 */
export const setMyNotificationPreference = onCall(
  OPTIONS,
  async (request) => {
    const uid = requireUid(request)
    const data = request.data as
      | { key?: unknown; enabled?: unknown }
      | undefined
    const key = data?.key
    const enabled = data?.enabled

    if (!isWritableNotificationPreference(key)) {
      throw new HttpsError(
        "invalid-argument",
        "Unknown notification preference."
      )
    }
    if (typeof enabled !== "boolean") {
      throw new HttpsError(
        "invalid-argument",
        "A preference must be true or false."
      )
    }

    await db.collection("users").doc(uid).set(
      { notifications: { preferences: { [key]: enabled } } },
      { merge: true }
    )

    return { key, enabled }
  }
)
