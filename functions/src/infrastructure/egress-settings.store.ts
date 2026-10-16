/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * Where a caller's own egress pool lives.
 *
 * The same split `storage-settings.store.ts` makes, for the same reason
 * -------------------------------------------------------------------------
 * One field in the caller's Firestore document, `secretPath`, and the pool
 * itself in Secret Manager. A proxy URL is `scheme://user:pass@host:port`, i.e.
 * a password, and a Firestore document is backed up, exported and read by
 * rules -- none of which should be able to surface a credential.
 *
 * Why the document holds a pointer and nothing else
 * ------------------------------------------------
 * A present pointer means "this caller has their own exits"; an absent one means
 * "use the platform pool". A `mode` beside it could disagree with the pointer,
 * and a `count` could disagree with the secret, so neither exists. The
 * consequence is that the read has three states rather than two, which is what
 * `readEgressPool` returns and `egressFrom` interprets.
 *
 * Exactly ONE function reads the secret
 * ------------------------------------
 * `readEgressPool` is it. Everything else -- the settings route, the resolver --
 * goes through it, at the cost of one extra document read on the settings path.
 * That is deliberate: it keeps "who can read a caller's proxy password?"
 * answerable by searching for one name rather than by auditing every caller.
 */
import {
  db,
  getSecretFromManager,
  purgeSecretAndAllRevisions,
  upsertSecretValue,
} from "../app/config"
import {
  DEFAULT_EGRESS,
  egressFrom,
  egressSecretId,
  parseEgressPool,
  serializeEgressPool,
  toPublicEgress,
  type EgressResolution,
  type EgressSettingsPublic,
  type EgressWrite,
} from "../domain/byo-egress.domain"

/**
 * The caller's egress document.
 * @param {string} uid The verified caller uid.
 * @return {*} The Firestore document reference.
 */
const settingsRef = (uid: string) =>
  db.collection("users").doc(uid).collection("egress").doc("settings")

/**
 * The document's fields as read. All untrusted: Firestore is a store, not a
 * validator, so a hand-edited document must not become a mode.
 */
type StoredEgressDoc = {
  secretPath?: unknown
}

/**
 * The caller's own pool, or the reason there is none.
 *
 * The three return values are the whole contract, and none may be conflated:
 * `undefined` is "no pointer, so use the platform pool", `null` is "a pointer
 * exists and did not resolve, so REFUSE", and an array is the caller's exits.
 * Collapsing the first two is the one mistake with a silent consequence -- it
 * puts a caller who configured their own exit back onto our addresses without
 * telling them.
 *
 * The ONLY function that reads the stored secret.
 * @param {string} uid The verified caller uid.
 * @return {Promise<string[] | null | undefined>} The pool, or which absence.
 */
export const readEgressPool = async (
  uid: string
): Promise<string[] | null | undefined> => {
  const snapshot = await settingsRef(uid).get()

  if (!snapshot.exists) {
    return undefined
  }

  const data = (snapshot.data() ?? {}) as StoredEgressDoc
  const path =
    typeof data.secretPath === "string" ? data.secretPath.trim() : ""

  if (path.length === 0) {
    return undefined
  }

  // A read failure is `null` rather than a throw: the caller has a pointer, so
  // the honest answer is "configured but unusable", which refuses the call. It
  // is NOT an invitation to fall back to the platform pool.
  try {
    return parseEgressPool(await getSecretFromManager(path))
  } catch (error) {
    console.warn(
      "egress: could not read the caller's pool:",
      error instanceof Error ? error.name : typeof error
    )
    return null
  }
}

/**
 * The pool a request should actually use.
 *
 * ponytail: this resolves per CALL, so a BYO caller costs one document read plus
 * one Secret Manager access per worker call. The platform pool is cached for 30s
 * next door; this deliberately is not, because a cache here would keep serving a
 * proxy the caller has already retired, and the group that pays for it is the
 * minority who configured their own egress. Add a short TTL -- and a bounded
 * map, not an unbounded one -- when the access count shows up on a bill.
 * @param {string} uid The verified caller uid.
 * @return {Promise<EgressResolution>} The pool to use, or the refusal.
 */
export const resolveEgress = async (
  uid: string
): Promise<EgressResolution> => egressFrom(await readEgressPool(uid))

/**
 * The caller's own egress as they may see it.
 *
 * Reads the pool so the caller can confirm WHICH exits they configured, masked
 * down to host:port by `toPublicProxies`. `mode` follows the POINTER rather than
 * the parse, so a caller whose secret has gone unreadable still reads as `byo`
 * with no exits -- which is the honest description of their state, and is the
 * same condition the resolver refuses on.
 * @param {string} uid The verified caller uid.
 * @return {Promise<EgressSettingsPublic>} A body with no credential in it.
 */
export const readEgressSettings = async (
  uid: string
): Promise<EgressSettingsPublic> => {
  const stored = await readEgressPool(uid)

  if (stored === undefined) {
    return DEFAULT_EGRESS
  }

  const resolution = egressFrom(stored)

  return toPublicEgress({
    mode: "byo",
    pool: resolution.kind === "tenant" ? resolution.pool : [],
  })
}

/**
 * Persist one validated write.
 *
 * The secret is written BEFORE the pointer, so a crash between the two leaves an
 * orphaned secret rather than a document claiming credentials that cannot be
 * loaded -- the same ordering, for the same reason, as `writeStorageSettings`.
 *
 * Clearing reads the pointer BEFORE removing it. After the write nothing records
 * which secret this caller's pool went to, so the value would sit in Secret
 * Manager forever with no way to find it, and "I removed my proxy" would be
 * untrue.
 * @param {string} uid The verified caller uid.
 * @param {EgressWrite} write The validated write.
 * @return {Promise<EgressSettingsPublic>} The new public settings.
 */
export const writeEgressSettings = async (
  uid: string,
  write: EgressWrite
): Promise<EgressSettingsPublic> => {
  const { FieldValue } = await import("firebase-admin/firestore")

  if (write.mode === "platform") {
    const existing = await settingsRef(uid).get()
    const priorPath = (existing.data() as StoredEgressDoc | undefined)
      ?.secretPath

    await settingsRef(uid).set(
      {
        secretPath: FieldValue.delete(),
        updatedAt: Date.now(),
      },
      { merge: true }
    )

    // Best-effort. The mode change is already committed, so failing the request
    // here would report an error for a change that DID take effect. A value that
    // survives is unreferenced rather than readable.
    if (typeof priorPath === "string" && priorPath.length > 0) {
      try {
        await purgeSecretAndAllRevisions(priorPath)
      } catch (error) {
        console.warn(
          "egress: could not purge the caller's pool:",
          error instanceof Error ? error.name : typeof error
        )
      }
    }

    return DEFAULT_EGRESS
  }

  const secretPath = await upsertSecretValue(
    egressSecretId(uid),
    serializeEgressPool(write.proxies)
  )

  await settingsRef(uid).set(
    { secretPath, updatedAt: Date.now() },
    { merge: true }
  )

  // Projected through the SAME helper the read path uses, so the label a caller
  // sees on the response to their write is the label they will see on every
  // later read. Deriving it twice would be two naming rules.
  const resolution = egressFrom(write.proxies)

  return toPublicEgress({
    mode: "byo",
    pool: resolution.kind === "tenant" ? resolution.pool : [],
  })
}
