/* eslint-disable object-curly-spacing */
/**
 * Where a caller's own Fly organization lives.
 *
 * The same split `egress-settings.store.ts` makes, for a stronger reason
 * ---------------------------------------------------------------------
 * One field in the caller's Firestore document, `secretPath`, and the config
 * itself in Secret Manager. A Fly deploy token can create and destroy machines
 * in the caller's organization, and a Firestore document is backed up, exported
 * and read by rules -- none of which should be able to surface a credential.
 *
 * Why the document holds a pointer and nothing else
 * ------------------------------------------------
 * A present pointer means "this caller runs on their own Fly"; an absent one
 * means "use ours". A `mode` beside it could disagree with the pointer, and an
 * `app` beside it could disagree with the secret, so neither exists. The
 * consequence is that the read has three states rather than two, which is what
 * `readFlyTenantConfig` returns and `computeFrom` interprets.
 *
 * Exactly ONE function reads the secret
 * ------------------------------------
 * `readFlyTenantConfig` is it. Everything else -- the settings route, the
 * resolver -- goes through it, at the cost of one extra document read on the
 * settings path. That is deliberate: it keeps "who can read a caller's Fly
 * deploy token?" answerable by searching for one name rather than by auditing
 * every caller.
 */
import {
  db,
  getSecretFromManager,
  purgeSecretAndAllRevisions,
  upsertSecretValue,
} from "../app/config"
import {
  computeFrom,
  computeSecretId,
  DEFAULT_COMPUTE,
  parseFlyTenant,
  serializeFlyTenant,
  toPublicCompute,
  type ComputeResolution,
  type ComputeSettingsPublic,
  type ComputeWrite,
  type FlyTenantConfig,
} from "../domain/byo-compute.domain"

/**
 * The caller's compute document.
 * @param {string} uid The verified caller uid.
 * @return {*} The Firestore document reference.
 */
const settingsRef = (uid: string) =>
  db.collection("users").doc(uid).collection("compute").doc("settings")

/**
 * The document's fields as read. All untrusted: Firestore is a store, not a
 * validator, so a hand-edited document must not become a mode.
 */
type StoredComputeDoc = {
  secretPath?: unknown
}

/**
 * The caller's own Fly config, or the reason there is none.
 *
 * The three return values are the whole contract, and none may be conflated:
 * `undefined` is "no pointer, so use the platform identity", `null` is "a
 * pointer exists and did not resolve, so REFUSE", and a config is theirs.
 * Collapsing the first two is the one mistake with a silent, expensive
 * consequence -- it creates a caller's machines in our organization and bills
 * us, while they believe the work landed on their own account.
 *
 * The ONLY function that reads the stored secret.
 * @param {string} uid The verified caller uid.
 * @return {Promise<FlyTenantConfig | null | undefined>} The config, or which
 * absence.
 */
export const readFlyTenantConfig = async (
  uid: string
): Promise<FlyTenantConfig | null | undefined> => {
  const snapshot = await settingsRef(uid).get()

  if (!snapshot.exists) {
    return undefined
  }

  const data = (snapshot.data() ?? {}) as StoredComputeDoc
  const path =
    typeof data.secretPath === "string" ? data.secretPath.trim() : ""

  if (path.length === 0) {
    return undefined
  }

  // A read failure is `null` rather than a throw: the caller has a pointer, so
  // the honest answer is "configured but unusable", which refuses the call. It
  // is NOT an invitation to fall back to the platform identity.
  try {
    return parseFlyTenant(await getSecretFromManager(path))
  } catch (error) {
    console.warn(
      "compute: could not read the caller's config:",
      error instanceof Error ? error.name : typeof error
    )
    return null
  }
}

/**
 * Whose Fly organization a request should act on.
 *
 * ponytail: this resolves per CALL, so a BYO caller costs one document read
 * plus one Secret Manager access per machine operation. It is deliberately not
 * cached, because a cache would keep acting on an app the caller has already
 * retired, and the cost falls on the minority who configured their own compute.
 * Add a short TTL -- a bounded map, not an unbounded one -- when the access
 * count shows up on a bill.
 * @param {string} uid The verified caller uid.
 * @return {Promise<ComputeResolution>} The identity to act as, or the refusal.
 */
export const resolveCompute = async (
  uid: string
): Promise<ComputeResolution> => computeFrom(await readFlyTenantConfig(uid))

/**
 * The caller's own compute as they may see it.
 *
 * Reads the config so a caller can confirm WHICH app they configured. The
 * projection runs through the same `toPublicCompute` the write path returns, so
 * what a caller sees on the answer to their write is what they see on every
 * later read.
 * @param {string} uid The verified caller uid.
 * @return {Promise<ComputeSettingsPublic>} A body with no credential in it.
 */
export const readComputeSettings = async (
  uid: string
): Promise<ComputeSettingsPublic> => {
  const stored = await readFlyTenantConfig(uid)

  if (stored === undefined) {
    return DEFAULT_COMPUTE
  }

  return toPublicCompute(computeFrom(stored))
}

/**
 * Persist one validated write.
 *
 * The secret is written BEFORE the pointer, so a crash between the two leaves an
 * orphaned secret rather than a document claiming credentials that cannot be
 * loaded -- the same ordering, for the same reason, as `writeEgressSettings`.
 *
 * Clearing reads the pointer BEFORE removing it. After the write nothing records
 * which secret this caller's config went to, so the token would sit in Secret
 * Manager forever with no way to find it, and "I removed my credentials" would
 * be untrue.
 * @param {string} uid The verified caller uid.
 * @param {ComputeWrite} write The validated write.
 * @return {Promise<ComputeSettingsPublic>} The new public settings.
 */
export const writeComputeSettings = async (
  uid: string,
  write: ComputeWrite
): Promise<ComputeSettingsPublic> => {
  const { FieldValue } = await import("firebase-admin/firestore")

  if (write.mode === "platform") {
    const existing = await settingsRef(uid).get()
    const priorPath = (existing.data() as StoredComputeDoc | undefined)
      ?.secretPath

    await settingsRef(uid).set(
      {
        secretPath: FieldValue.delete(),
        updatedAt: Date.now(),
      },
      { merge: true }
    )

    // Best-effort. The mode change is already committed, so failing the request
    // here would report an error for a change that DID take effect. A token that
    // survives is unreferenced rather than readable.
    if (typeof priorPath === "string" && priorPath.length > 0) {
      try {
        await purgeSecretAndAllRevisions(priorPath)
      } catch (error) {
        console.warn(
          "compute: could not purge the caller's config:",
          error instanceof Error ? error.name : typeof error
        )
      }
    }

    return DEFAULT_COMPUTE
  }

  const secretPath = await upsertSecretValue(
    computeSecretId(uid),
    serializeFlyTenant({
      app: write.app,
      token: write.token,
      region: write.region,
    })
  )

  await settingsRef(uid).set(
    { secretPath, updatedAt: Date.now() },
    { merge: true }
  )

  return toPublicCompute(
    computeFrom({
      app: write.app,
      token: write.token,
      region: write.region,
    })
  )
}
