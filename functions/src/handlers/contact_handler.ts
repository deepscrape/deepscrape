/* eslint-disable max-len */
/* eslint-disable indent */
/* eslint-disable object-curly-spacing */
import { Request, Response } from "express"
import {
  validateContactInput,
  sanitizeContactInput,
  storeContactSubmission,
  sendContactNotification,
  verifyRecaptchaToken,
} from "../domain/contact.domain"

/**
 * POST /services/contact
 *
 * Accepts a contact form submission, validates input, verifies the Firebase
 * App Check token (reCAPTCHA-backed), stores it in Firestore, sends an email
 * notification via Resend, and returns a success or error response.
 *
 * This route is CSRF-bypassed (listed in CSRF_IGNORED_PATH_PREFIXES) and is
 * protected instead by the Upstash IP rate limiter and App Check. It
 * intentionally does NOT require authentication so visitors can reach out.
 * @param {Request} req - Express request object with contact form body (name, email, subject, message, recaptchaToken)
 * @param {Response} res - Express response object
 * @return {Promise<Response>} 201 when delivered, 424 when the mail failed
 */
export const submitContact = async (req: Request, res: Response) => {
  try {
    const errors = validateContactInput(req.body)

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Validation failed.",
        errors,
      })
    }

    // Verify Firebase App Check token from X-Firebase-AppCheck header
    // (per Firebase docs: https://firebase.google.com/docs/app-check/custom-resource-backend)
    const appCheckToken = req.header("X-Firebase-AppCheck") || null
    const isHuman = await verifyRecaptchaToken(appCheckToken)

    if (!isHuman) {
      return res.status(403).json({
        success: false,
        message: "reCAPTCHA verification failed. Please try again.",
      })
    }

    const sanitized = sanitizeContactInput(req.body)
    const docId = await storeContactSubmission(sanitized)

    console.log(`[contact] Submission stored: ${docId} from ${sanitized.email}`)

    // Await the send. Cloud Run freezes the instance the moment the response
    // is written, so a floating promise loses the mail under load.
    const notified = await sendContactNotification(sanitized)

    if (!notified) {
      // The submission is stored, so this is not a 5xx and nothing is lost.
      // The visitor is told the truth instead of a success that did not
      // happen, and the wording makes a resubmission unnecessary.
      console.error(
        `[contact] Submission ${docId} stored, notification failed`
      )
      return res.status(424).json({
        success: false,
        message:
          "Your message was saved, but our confirmation email could " +
          "not be sent. Please email support@deepscrape.dev if you " +
          "need a reply.",
        id: docId,
      })
    }

    return res.status(201).json({
      success: true,
      message: "Thank you! Your message has been received. We'll get back to you shortly.",
      id: docId,
    })
  } catch (error) {
    console.error("[contact] Error processing submission:", error)
    return res.status(500).json({
      success: false,
      message: "An unexpected error occurred. Please try again later.",
    })
  }
}
