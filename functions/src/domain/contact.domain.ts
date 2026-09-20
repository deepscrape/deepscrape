/* eslint-disable object-curly-spacing */
/* eslint-disable max-len */
import { Timestamp } from "firebase-admin/firestore"
import { db } from "../app/config"
import { env } from "../config/env"
import { Resend } from "resend"
import { getAppCheck } from "firebase-admin/app-check"

/**
 * Contact form submission data
 */
export interface ContactSubmission {
  name: string
  email: string
  subject: string
  message: string
  createdAt: Timestamp
  source?: string
  replied?: boolean
  repliedAt?: Timestamp | null
  archived?: boolean
}

/**
 * Validates contact form input and returns a list of error messages.
 * @param {*} body
 * @return {*}
 */
export const validateContactInput = (body: Record<string, unknown>): string[] => {
  const errors: string[] = []

  const name = typeof body.name === "string" ? body.name.trim() : ""
  const email = typeof body.email === "string" ? body.email.trim() : ""
  const subject = typeof body.subject === "string" ? body.subject.trim() : ""
  const message = typeof body.message === "string" ? body.message.trim() : ""

  if (!name || name.length < 2) {
    errors.push("Name must be at least 2 characters.")
  }
  if (name.length > 100) {
    errors.push("Name must not exceed 100 characters.")
  }

  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
  if (!email || !emailRegex.test(email)) {
    errors.push("A valid email address is required.")
  }

  if (!subject || subject.length < 3) {
    errors.push("Subject must be at least 3 characters.")
  }
  if (subject.length > 200) {
    errors.push("Subject must not exceed 200 characters.")
  }

  if (!message || message.length < 10) {
    errors.push("Message must be at least 10 characters.")
  }
  if (message.length > 5000) {
    errors.push("Message must not exceed 5000 characters.")
  }

  return errors
}

/**
 * Sanitizes and prepares contact form data for Firestore storage.
 * @param {*} body
 * @return {*}
 */
export const sanitizeContactInput = (body: Record<string, unknown>): Omit<ContactSubmission, "createdAt"> => ({
  name: String(body.name ?? "").trim().slice(0, 100),
  email: String(body.email ?? "").trim().toLowerCase().slice(0, 254),
  subject: String(body.subject ?? "").trim().slice(0, 200),
  message: String(body.message ?? "").trim().slice(0, 5000),
  source: String(body.source ?? "website").trim().slice(0, 50),
  replied: false,
  repliedAt: null,
  archived: false,
})

/**
 * Verifies a Firebase App Check token using the Firebase Admin SDK.
 * App Check internally uses reCAPTCHA v3 via the already-configured
 * ReCaptchaV3Provider in the Angular app.
 *
 * Per Firebase docs:
 * https://firebase.google.com/docs/app-check/custom-resource-backend
 *
 * In the emulator, silently passes when the token is absent since App Check
 * is not enforced there. In production a missing token is rejected so the
 * gate cannot be bypassed by simply omitting the header.
 * @param {*} token
 */
export const verifyRecaptchaToken = async (token: string | null | undefined): Promise<boolean> => {
  if (!token) {
    if (env.IS_EMULATOR) {
      console.warn("[contact] App Check token missing from header — allowing in emulator/dev mode")
      return true
    }
    console.warn("[contact] App Check token missing from header — rejecting")
    return false
  }

  try {
    const appCheck = getAppCheck()
    const decoded = await appCheck.verifyToken(token)
    console.log(`[contact] App Check verified — appId: ${decoded.appId}`)
    return true
  } catch (error) {
    console.error("[contact] App Check verification failed:", error)
    return false
  }
}

/**
 * Stores a validated contact submission in Firestore under the "contacts" collection.
 * Returns the generated document ID.
 * @param {*} data
 */
export const storeContactSubmission = async (
  data: Omit<ContactSubmission, "createdAt">
): Promise<string> => {
  const docRef = await db.collection("contacts").add({
    ...data,
    createdAt: Timestamp.now(),
  })
  return docRef.id
}

/* ------------------------------------------------------------------ */
/*  Resend email notification                                          */
/* ------------------------------------------------------------------ */

/**
 * Sends a notification email via Resend to the support team when a
 * new contact form is submitted. The sender receives a confirmation too.
 *
 * Silently swallows errors so a failed email never breaks the form response.
 * @param {*} data
 */
export const sendContactNotification = async (
  data: Omit<ContactSubmission, "createdAt">
): Promise<void> => {
  const apiKey = env.RESEND_API_KEY
  const fromEmail = env.RESEND_FROM_EMAIL

  if (!apiKey || !fromEmail) {
    console.warn("[contact] RESEND_API_KEY or RESEND_FROM_EMAIL not configured — skipping email notification")
    return
  }

  try {
    const resend = new Resend(apiKey)

    // 1. Notify the support team
    const supportResult = await resend.emails.send({
      from: `deepscrape Contact <${fromEmail}>`,
      to: fromEmail,
      replyTo: data.email,
      subject: `[Contact] ${data.subject}`,
      html: [
        "<div style=\"font-family:sans-serif;max-width:600px;margin:0 auto;\">",
        "<h2 style=\"color:#0891b2;\">New Contact Form Submission</h2>",
        "<table style=\"width:100%;border-collapse:collapse;\">",
        `<tr><td style="padding:8px;font-weight:600;border-bottom:1px solid #eee;">Name</td><td style="padding:8px;border-bottom:1px solid #eee;">${data.name}</td></tr>`,
        `<tr><td style="padding:8px;font-weight:600;border-bottom:1px solid #eee;">Email</td><td style="padding:8px;border-bottom:1px solid #eee;"><a href="mailto:${data.email}">${data.email}</a></td></tr>`,
        `<tr><td style="padding:8px;font-weight:600;border-bottom:1px solid #eee;">Subject</td><td style="padding:8px;border-bottom:1px solid #eee;">${data.subject}</td></tr>`,
        `<tr><td style="padding:8px;font-weight:600;border-bottom:1px solid #eee;">Source</td><td style="padding:8px;border-bottom:1px solid #eee;">${data.source ?? "website"}</td></tr>`,
        "</table>",
        "<h3 style=\"margin-top:24px;color:#374151;\">Message</h3>",
        `<p style="background:#f9fafb;padding:16px;border-radius:8px;line-height:1.6;white-space:pre-wrap;">${data.message}</p>`,
        "</div>",
      ].join("\n"),
    })

    if (supportResult.error) {
      console.error("[contact] Support notification failed:", supportResult.error)
    } else {
      console.log(`[contact] Support notification sent: ${supportResult.data?.id}`)
    }

    // 2. Send an auto-reply confirmation to the visitor
    const confirmResult = await resend.emails.send({
      from: `deepscrape <${fromEmail}>`,
      to: data.email,
      subject: `We received your message — ${data.subject}`,
      html: [
        "<div style=\"font-family:sans-serif;max-width:600px;margin:0 auto;\">",
        `<h2 style="color:#0891b2;">Thank you for reaching out, ${data.name}!</h2>`,
        "<p style=\"color:#374151;line-height:1.6;\">",
        "We've received your message and will get back to you as soon as possible.",
        "Typically, we respond within 24 hours during business days.</p>",
        "<hr style=\"border:none;border-top:1px solid #e5e7eb;margin:24px 0;\" />",
        "<h3 style=\"color:#374151;\">Your message summary</h3>",
        `<p style="background:#f9fafb;padding:16px;border-radius:8px;line-height:1.6;white-space:pre-wrap;">${data.message}</p>`,
        "<p style=\"color:#9ca3af;font-size:12px;\">— deepscrape team</p>",
        "</div>",
      ].join("\n"),
    })

    if (confirmResult.error) {
      console.error("[contact] Auto-reply failed:", confirmResult.error)
    } else {
      console.log(`[contact] Auto-reply sent to ${data.email}: ${confirmResult.data?.id}`)
    }
  } catch (error) {
    console.error("[contact] Failed to send email notification:", error)
    // Never break the form response for an email failure
  }
}
