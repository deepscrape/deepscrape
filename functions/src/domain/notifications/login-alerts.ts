/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
import { FieldValue, Timestamp } from "firebase-admin/firestore"
import { db } from "../../app/config"

/**
 * "New location" login detection — the missing half of the security-alert stack.
 *
 * Every other piece already existed (`users/{uid}/alerts`, the security email
 * sender, the audit/timeline writer, geo on each session); what was absent was any
 * comparison of a login's geo against the user's history. This is that comparison.
 *
 * The history is `users/{uid}.knownCountries`, not a query over `loginSessions`. That
 * query read up to 20 full session documents on every single login and, with no orderBy,
 * Firestore handed back whichever 20 the index yielded first — so the answer came from an
 * arbitrary old slice of history, got worse as the collection grew, and the cost landed
 * inside the login response. The user document is read here anyway for the opt-out, so the
 * country set now costs nothing extra, is exact, and needs no composite index.
 * ponytail: countries are bounded by the number of countries there are; no cap needed.
 */

const UNKNOWN_VALUES = new Set(["", "unknown", "n/a", "null", "undefined"])

const isKnown = (value: string | undefined): value is string =>
  !!value && !UNKNOWN_VALUES.has(value.trim().toLowerCase())

export type LoginLocationInput = {
  uid: string
  sessionId: string
  ip: string
  country?: string
  region?: string
  location?: string
  userAgent?: string
}

/**
 * Write a security alert when a signed-in session comes from a country the user has
 * never used before.
 *
 * Never throws: this runs on the login path, so a failure to *warn* must never be a
 * failure to *log in*.
 *
 * @param {LoginLocationInput} input Session geo resolved by createLoginSession.
 * @return {Promise<boolean>} True when an alert was written.
 */
/**
 * detectNewLoginLocation
 * @param {*} input
 */
export async function detectNewLoginLocation(input: LoginLocationInput): Promise<boolean> {
  try {
    const country = input.country?.trim()
    if (!isKnown(country) || !input.uid) return false

    const normalizedCountry = country.trim().toLowerCase()
    const userRef = db.doc(`users/${input.uid}`)
    const userSnap = await userRef.get()
    const userData = userSnap.data() as {
      notifications?: { securityAlerts?: boolean }
      knownCountries?: string[]
    } | undefined

    // Opt-out via the existing typed field (undefined = enabled).
    if (userData?.notifications?.securityAlerts === false) return false

    const knownCountries = new Set<string>(
      (userData?.knownCountries || []).filter(isKnown).map((entry) => entry.trim().toLowerCase())
    )

    // First country an account is ever seen from is not a "new location" — there is nothing
    // to compare against, and alerting on it would train users to ignore the bell.
    const isNewCountry = knownCountries.size > 0 && !knownCountries.has(normalizedCountry)

    // Remember it either way, so an alert can fire for the *next* unseen country. Atomic, and
    // skipped on the common path: a login from a country we already know is one read, no write.
    if (!knownCountries.has(normalizedCountry)) {
      await userRef.set({ knownCountries: FieldValue.arrayUnion(country) }, { merge: true })
    }

    if (!isNewCountry) return false

    await db.collection("users").doc(input.uid).collection("alerts").add({
      type: "warning",
      // Read by the alert fan-out trigger to pick channels and copy. Writing the
      // document is now the ONLY thing a producer does — email and push are owned
      // by onSecurityAlertCreated.
      category: "new_login_location",
      severity: "warning",
      title: "New sign-in location",
      message: `Your account was accessed from ${input.location || country} for the first time. If this wasn't you, revoke the session and change your password.`,
      createdAt: Timestamp.now(),
      read: false,
      metadata: {
        source: "detectNewLoginLocation",
        sessionId: input.sessionId,
        ip: input.ip,
        country,
        region: input.region || null,
        location: input.location || null,
        userAgent: input.userAgent || null,
        knownCountries: [...knownCountries].slice(0, 20),
      },
    })

    return true
  } catch (error) {
    console.warn("detectNewLoginLocation skipped:", error)
    return false
  }
}
