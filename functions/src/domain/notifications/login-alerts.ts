/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
import { Timestamp } from "firebase-admin/firestore"
import { db } from "../../app/config"

/**
 * "New location" login detection — the missing half of the security-alert stack.
 *
 * Every other piece already existed (`users/{uid}/alerts`, the security email
 * sender, the audit/timeline writer, geo on each session); what was absent was any
 * comparison of a login's geo against the user's history. This is that comparison.
 *
 * Deliberately does NOT order by createdAt: `where(userId) + orderBy(createdAt)`
 * needs a composite index, and a *sample* of the user's sessions is sufficient —
 * any single prior session from the same country proves the country is not new.
 * ponytail: 20-doc sample, add the composite index + a wider window if a user ever
 * accumulates enough history that 20 arbitrary sessions miss a known country.
 */

const SAMPLE_SIZE = 20
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

    const [userSnap, priorSessions] = await Promise.all([
      db.doc(`users/${input.uid}`).get(),
      db.collection("loginSessions").where("userId", "==", input.uid).limit(SAMPLE_SIZE).get(),
    ])

    // Opt-out via the existing typed field (undefined = enabled).
    const notifications = userSnap.data()?.notifications as { securityAlerts?: boolean } | undefined
    if (notifications?.securityAlerts === false) return false

    const seenCountries = new Set<string>()
    for (const session of priorSessions.docs) {
      if (session.id === input.sessionId) continue
      const priorCountry = (session.data() as { country?: string }).country
      if (isKnown(priorCountry)) seenCountries.add(priorCountry.trim().toLowerCase())
    }

    // First-ever session (or no prior country recorded) is not a "new location" —
    // there is nothing to compare against, and alerting on it would train users to
    // ignore the bell.
    if (!seenCountries.size || seenCountries.has(country.toLowerCase())) return false

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
        knownCountries: [...seenCountries].slice(0, 20),
      },
    })

    return true
  } catch (error) {
    console.warn("detectNewLoginLocation skipped:", error)
    return false
  }
}
