/* eslint-disable object-curly-spacing */
/**
 * Where a user's scrape-provider preference lives, and how it is read back.
 *
 * One small document per user rather than a field on `users/{uid}`: the user
 * document is read by other services (arachnefly reads it for `GetUserInfo`),
 * and
 * a preference that changes whenever someone clicks a toggle does not belong in
 * the hot document for the whole account.
 *
 * Path: `users/{uid}/settings/preferences`, field `scrapeProvider`.
 *
 * Both functions are total — they do not throw for the *absence* of a
 * preference, which is the normal case.
 */
import { db } from "../app/config"
import type { ScrapeProviderId } from "../domain/scrape-providers.domain"

const PREFERENCE_DOC = (uid: string): string => `users/${uid}/settings/preferences`

export const SCRAPE_PROVIDER_FIELD = "scrapeProvider"

/**
 * The stored preference, or `undefined` when there is not one.
 *
 * A failed read returns `undefined` rather than propagating. The platform
 * default
 * is always a correct answer to "which provider?", so refusing to scrape
 * because a
 * preferences lookup hiccuped would turn a cosmetic problem into an outage. The
 * failure is logged, which is what makes it fixable.
 * @param {*} uid
 */
export const readStoredProvider = async (uid: string): Promise<unknown> => {
  try {
    const snapshot = await db.doc(PREFERENCE_DOC(uid)).get()
    if (!snapshot.exists) {
      return undefined
    }
    return (snapshot.data() as Record<string, unknown> | undefined)?.[SCRAPE_PROVIDER_FIELD]
  } catch (error) {
    console.warn("scrape-provider: preference read failed, using the platform default:", error)
    return undefined
  }
}

/**
 * Persists a preference.
 *
 * `merge` on purpose: this document will hold more than one preference, and a
 * whole-document write here would silently erase the others the moment a second
 * setting is added.
 *
 * Validation is the caller's job — this writes what it is given, and
 * `resolveProvider` refuses to act on anything the catalogue does not
 * recognise,
 * so an invalid value is inert rather than dangerous.
 * @param {*} uid
 * @param {*} provider
 */
export const writeStoredProvider = async (uid: string, provider: ScrapeProviderId): Promise<void> => {
  await db.doc(PREFERENCE_DOC(uid)).set({ [SCRAPE_PROVIDER_FIELD]: provider }, { merge: true })
}
