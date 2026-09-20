/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
import { env } from "../../config/env"
import { EmailContent } from "../../infrastructure/email"

/**
 * How each kind of security alert is presented, per channel.
 *
 * This exists so that adding an alert kind is a data change, not a wiring change:
 * a writer drops a document into `users/{uid}/alerts` with a `category`, and the
 * fan-out trigger asks this module what that category should say and where it
 * should go. Without it, every new alert type would re-implement "email + push"
 * in its own call site (which is how the current inline MFA email came to exist).
 *
 * Channel defaults are deliberately asymmetric: push is cheap and always allowed,
 * email costs money and domain reputation, so a category must opt IN to email.
 * An unrecognised category therefore pings the bell and the device, and never
 * sends mail.
 */

export type AlertCategory =
    | "new_login_location"
    | "new_trusted_device"
    | "mfa_disabled"

/** Subset of the alert document this module reads. */
export type AlertDocData = {
    type?: string
    category?: string
    title?: string
    message?: string
    severity?: string
    createdAt?: { toDate?: () => Date }
    metadata?: Record<string, unknown>
}

export type AlertPresentation = {
    channels: { email: boolean; push: boolean }
    pushTitle: string
    pushBody: string
    email?: { subject: string; content: EmailContent }
}

const SECURITY_URL = `${env.APP_ORIGIN}/settings/security`

const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : ""

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value

const meta = (data: AlertDocData, key: string): string =>
  str(data.metadata?.[key])

// Compact, unambiguous timestamp — email has no user locale to format against.
const formatWhen = (data: AlertDocData): string => {
  const date = data.createdAt?.toDate?.()
  if (!date) return ""
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`
}

/**
 * Resolve the channels and copy for one alert document.
 *
 * @param {AlertDocData} data The document written into `users/{uid}/alerts`.
 * @return {AlertPresentation} Channels plus per-channel content.
 */
export const presentAlert = (data: AlertDocData): AlertPresentation => {
  const when = formatWhen(data)

  if (data.category === "new_login_location") {
    const location = meta(data, "location") || meta(data, "country") || "a new location"
    const ip = meta(data, "ip")
    const device = truncate(meta(data, "userAgent"), 90)

    const details = [
      { label: "Location", value: location },
      ...(ip ? [{ label: "IP address", value: ip }] : []),
      ...(when ? [{ label: "Time", value: when }] : []),
      ...(device ? [{ label: "Device", value: device }] : []),
    ]

    const content: EmailContent = {
      preheader: `A sign-in from ${location} was not recognised on your account.`,
      heading: "New sign-in location",
      intro: `Your account was accessed from ${location} for the first time. If this was you, no action is needed.`,
      details,
      callout: {
        tone: "danger",
        text: "If this wasn't you, revoke the session and change your password now.",
      },
      cta: { label: "Review security settings", url: SECURITY_URL },
      footnote: `If you travel often, new locations are normal — this notice is sent once per location. Session reference: ${truncate(meta(data, "sessionId"), 60)}`,
    }

    return {
      channels: { email: true, push: true },
      pushTitle: "New sign-in location",
      pushBody: `Your account was accessed from ${location} for the first time.`,
      email: { subject: `New sign-in from ${location}`, content },
    }
  }

  if (data.category === "new_trusted_device") {
    const deviceName = meta(data, "deviceName") || "A new device"
    const deviceId = truncate(meta(data, "deviceId"), 60)

    const content: EmailContent = {
      preheader: `${deviceName} was added to your trusted devices.`,
      heading: "New device trusted",
      intro: `${deviceName} was verified and added to your trusted devices. Trusted devices skip the device verification step for 90 days.`,
      details: [
        { label: "Device", value: deviceName },
        ...(deviceId ? [{ label: "Device ID", value: deviceId }] : []),
        ...(when ? [{ label: "Trusted at", value: when }] : []),
      ],
      callout: {
        tone: "warning",
        text: "If you didn't add this device, remove it and change your password.",
      },
      cta: { label: "Manage trusted devices", url: SECURITY_URL },
    }

    return {
      channels: { email: true, push: true },
      pushTitle: "New device trusted",
      pushBody: `${deviceName} can now skip device verification.`,
      email: { subject: `New device trusted: ${deviceName}`, content },
    }
  }

  if (data.category === "mfa_disabled") {
    // Push only. The writer (`notifyMfaRiskEvent`) still sends this email
    // inline and honours the separate `riskEmailNotifications` preference;
    // emailing from here too would deliver the notice twice.
    // ponytail: move that inline send here once the fan-out owns email fully.
    return {
      channels: { email: false, push: true },
      pushTitle: data.title || "MFA disabled",
      pushBody: data.message || "Multi-factor authentication is no longer protecting your account.",
    }
  }

  // Unknown category: never email blindly, still notify the device.
  return {
    channels: { email: false, push: true },
    pushTitle: data.title || "Security notice",
    pushBody: data.message || "There was a new security-relevant change on your account.",
  }
}
