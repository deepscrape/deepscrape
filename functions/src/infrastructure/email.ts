/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
import { Resend } from "resend"
import { env } from "../config/env"

/**
 * Shared transactional email system (Resend transport + table-based layout).
 *
 * Why not Tailwind classes here: email HTML is not web HTML. Gmail drops
 * `<style>` blocks in several contexts, Outlook renders through the Word engine
 * (no flex/grid/border-radius support), and most clients block remote images by
 * default. The only layout that survives is nested `<table>` with inline styles.
 * So this module mirrors the app's design tokens as literal values instead of
 * reusing the CSS pipeline — the *look* matches the theme, the *mechanism* cannot.
 *
 * Why no logo image: a blocked remote image renders as a broken box above the
 * fold, which reads as phishing. The mark is drawn with table cells and a glyph.
 */

/** Mirrors the app theme map (primary cyan, rose for risk, gray neutrals). */
const TOKENS = {
  primary: "#0891b2",
  primaryDark: "#0e7490",
  danger: "#e11d48",
  dangerBg: "#fff1f2",
  dangerBorder: "#fecdd3",
  warning: "#b45309",
  warningBg: "#fffbeb",
  warningBorder: "#fde68a",
  infoBg: "#f0f9ff",
  infoBorder: "#bae6fd",
  pageBg: "#f4f6f9",
  cardBg: "#ffffff",
  heading: "#111318",
  body: "#3f4a57",
  muted: "#8a95a6",
  rule: "#e9edf2",
  detailBg: "#fafbfc",
} as const

const FONT_STACK =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

/**
 * Escape interpolated values before they reach the HTML part.
 *
 * Required, not defensive: the values interpolated into these templates come from
 * request data (geo city/region, User-Agent, device names) — an attacker who can
 * set a User-Agent could otherwise inject markup into a security email sent from
 * our domain.
 *
 * @param {string} value Raw value, possibly attacker-controlled.
 * @return {string} HTML-safe text.
 */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

export type EmailDetail = { label: string; value: string }

export type EmailCalloutTone = "danger" | "warning" | "info"

export type EmailContent = {
    /** Inbox preview line; hidden in the body. */
    preheader: string
    heading: string
    intro: string
    details?: EmailDetail[]
    callout?: { tone: EmailCalloutTone; text: string }
    cta?: { label: string; url: string }
    footnote?: string
}

const toneStyles = (tone: EmailCalloutTone): { bg: string; border: string; text: string; mark: string } => {
  if (tone === "danger") {
    return { bg: TOKENS.dangerBg, border: TOKENS.dangerBorder, text: TOKENS.danger, mark: "!" }
  }
  if (tone === "warning") {
    return { bg: TOKENS.warningBg, border: TOKENS.warningBorder, text: TOKENS.warning, mark: "!" }
  }
  return { bg: TOKENS.infoBg, border: TOKENS.infoBorder, text: TOKENS.primaryDark, mark: "i" }
}

const renderDetails = (details: EmailDetail[]): string => {
  const rows = details.map((detail, index) => {
    const border = index === details.length - 1 ? "none" : `1px solid ${TOKENS.rule}`
    return `
              <tr>
                <td style="padding:10px 14px;font-family:${FONT_STACK};font-size:13px;line-height:1.4;color:${TOKENS.muted};border-bottom:${border};white-space:nowrap;vertical-align:top;">${escapeHtml(detail.label)}</td>
                <td style="padding:10px 14px;font-family:${FONT_STACK};font-size:13px;line-height:1.4;color:${TOKENS.heading};border-bottom:${border};word-break:break-word;">${escapeHtml(detail.value)}</td>
              </tr>`
  }).join("")

  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${TOKENS.detailBg};border:1px solid ${TOKENS.rule};border-radius:12px;margin:0 0 20px 0;">
        <tbody>${rows}
        </tbody>
      </table>`
}

/**
 * Render the full HTML document for a transactional email.
 *
 * @param {EmailContent} content Heading, body copy and optional blocks.
 * @return {string} A complete, inline-styled HTML document.
 */
export const renderEmail = (content: EmailContent): string => {
  const tone = content.callout ? toneStyles(content.callout.tone) : null

  const callout = content.callout && tone ? `
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${tone.bg};border:1px solid ${tone.border};border-radius:12px;margin:0 0 20px 0;">
                    <tr>
                      <td width="44" valign="top" style="padding:16px 0 16px 16px;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                          <td align="center" width="24" height="24" bgcolor="${tone.text}" style="width:24px;height:24px;border-radius:12px;font-family:${FONT_STACK};font-size:14px;font-weight:700;line-height:24px;color:#ffffff;">${tone.mark}</td>
                        </tr></table>
                      </td>
                      <td style="padding:16px 16px 16px 10px;font-family:${FONT_STACK};font-size:14px;line-height:1.55;color:${tone.text};"><strong>${escapeHtml(content.callout.text)}</strong></td>
                    </tr>
                  </table>` : ""

  const details = content.details?.length ? renderDetails(content.details) : ""

  const cta = content.cta ? `
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px 0;">
                    <tr>
                      <td align="center" bgcolor="${TOKENS.primary}" style="border-radius:10px;">
                        <a href="${escapeHtml(content.cta.url)}" style="display:inline-block;padding:14px 30px;font-family:${FONT_STACK};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(content.cta.label)}</a>
                      </td>
                    </tr>
                  </table>` : ""

  const footnote = content.footnote ? `
                  <p style="margin:0;padding:0 32px 26px 32px;font-family:${FONT_STACK};font-size:12px;line-height:1.55;color:${TOKENS.muted};">${escapeHtml(content.footnote)}</p>` : ""

  return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeHtml(content.heading)}</title>
  <style>
    /* Progressive enhancement only: clients that strip <style> fall back to the
       inline light values below, which are chosen to be readable either way. */
    @media (prefers-color-scheme: dark) {
      .ds-page { background-color:#0b0f14 !important; }
      .ds-card { background-color:#161b22 !important; }
      .ds-heading { color:#e6edf3 !important; }
      .ds-body { color:#adbac7 !important; }
      .ds-rule { border-color:#232a33 !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:${TOKENS.pageBg};">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;color:${TOKENS.pageBg};">${escapeHtml(content.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ds-page" style="background-color:${TOKENS.pageBg};padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ds-card" style="max-width:520px;background-color:${TOKENS.cardBg};border-radius:16px;">
          <tr>
            <td style="padding:34px 32px 20px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px 0;">
                <tr>
                  <td width="26" height="26" align="center" bgcolor="${TOKENS.primary}" style="width:26px;height:26px;border-radius:7px;font-family:${FONT_STACK};font-size:15px;font-weight:800;line-height:26px;color:#ffffff;">d</td>
                  <td style="padding-left:9px;font-family:${FONT_STACK};font-size:15px;font-weight:700;letter-spacing:-0.2px;color:${TOKENS.heading};" class="ds-heading">deepscrape</td>
                </tr>
              </table>
              <h1 style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:21px;line-height:1.3;font-weight:700;letter-spacing:-0.3px;color:${TOKENS.heading};" class="ds-heading">${escapeHtml(content.heading)}</h1>
              <p style="margin:0 0 22px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:${TOKENS.body};" class="ds-body">${escapeHtml(content.intro)}</p>${callout}${details}${cta}
            </td>
          </tr>
          <tr>
            <td style="padding:0;">${footnote}</td>
          </tr>
          <tr>
            <td style="border-top:1px solid ${TOKENS.rule};padding:0;" class="ds-rule"></td>
          </tr>
          <tr>
            <td style="padding:20px 32px 30px 32px;">
              <p style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.6;color:${TOKENS.muted};">Sent because a security-relevant change happened on your deepscrape account. Transactional security notices cannot be unsubscribed; you can turn off optional channels in Security settings.</p>
            </td>
          </tr>
        </table>
        <p style="margin:14px 0 0 0;font-family:${FONT_STACK};font-size:11px;line-height:1.5;color:${TOKENS.muted};">deepscrape &middot; Security notice</p>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/**
 * Plain-text alternative.
 *
 * Always sent alongside the HTML part: a text-only fallback is what a mail
 * client shows when it cannot render HTML, and a missing text part is a
 * measurable spam-score penalty.
 *
 * @param {EmailContent} content Same content used for the HTML part.
 * @return {string} Plain-text body.
 */
export const renderEmailText = (content: EmailContent): string => {
  const lines = [content.heading, "", content.intro]

  if (content.callout) lines.push("", content.callout.text)
  if (content.details?.length) {
    lines.push("")
    for (const detail of content.details) lines.push(`${detail.label}: ${detail.value}`)
  }
  if (content.cta) lines.push("", `${content.cta.label}: ${content.cta.url}`)
  if (content.footnote) lines.push("", content.footnote)

  lines.push("", "— deepscrape · Security notice")
  return lines.join("\n")
}

export type SendEmailResult =
    | { ok: true; id?: string }
    | { ok: false; reason: string }

/**
 * Send one transactional email.
 *
 * Never throws. Every caller is on a path where email is a *side effect* of the
 * real work (a login, a device trust, an MFA change), so a provider outage must
 * degrade to "no email sent", never to "the operation failed".
 *
 * @param {object} args Recipient, subject and pre-rendered parts.
 * @return {Promise<SendEmailResult>} Success flag, or the reason it was skipped.
 */
export const sendEmail = async (args: {
    to: string
    subject: string
    html: string
    text: string
    /** Overrides the default security sender display name. */
    fromName?: string
}): Promise<SendEmailResult> => {
  const apiKey = env.RESEND_API_KEY
  const fromEmail = env.RESEND_FROM_EMAIL

  if (!apiKey || !fromEmail) {
    return { ok: false, reason: "email-not-configured" }
  }
  if (!args.to || !args.to.includes("@")) {
    return { ok: false, reason: "no-recipient" }
  }

  try {
    const resend = new Resend(apiKey)
    const result = await resend.emails.send({
      from: `${args.fromName || "deepscrape Security"} <${fromEmail}>`,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
    })

    if (result.error) {
      return { ok: false, reason: String(result.error.message || "provider-error") }
    }
    return { ok: true, id: result.data?.id }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "send-failed" }
  }
}
