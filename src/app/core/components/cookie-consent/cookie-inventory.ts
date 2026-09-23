/**
 * Every cookie this site sets, published in the same shape Cloudflare and other
 * OneTrust-style policies use: name, retention, category, purpose.
 *
 * One list, rendered by the consent banner (names + retention) and by the privacy
 * policy (full purpose), so the two cannot drift apart. Mirror of the writers, keep
 * in step with:
 * - `bff/security.ts` — `_csrf`, `_csrf_secret`
 * - `functions/src/gfunctions/analytics.ts` — `gid`, `guest_fp`
 * - `guest-tracking.service.ts` — `aid`
 * - `device-verification.service.ts` — `device_id`
 * - `cookie-consent.component.ts` — `consent`
 * - `_ga*` is Google's own, set by GA4 only after a grant (`app.config.ts`)
 *
 * No third-party and no targeting cookie exists on this site, which is why the list
 * is this short: see the privacy policy's cookie section.
 */
export type CookieCategory = 'necessary' | 'analytics' | 'functional'

export interface CookieEntry {
  /** Cookie name as it appears in the browser's storage inspector. */
  name: string
  /** Published retention. "Session" clears when the browser closes. */
  duration: string
  category: CookieCategory
  /** What it is for, in plain language. */
  purpose: string
}

export const COOKIE_INVENTORY: readonly CookieEntry[] = [
  {
    name: '_csrf',
    duration: 'Session',
    category: 'necessary',
    purpose: 'Double-submit value the browser sends back as the csrf-token header, so a ' +
      'request that changes something cannot be forged by another site.',
  },
  {
    name: '_csrf_secret',
    duration: 'Session',
    category: 'necessary',
    purpose: 'Signed secret the token above is validated against. HttpOnly, so no script ' +
      'on the page can read it.',
  },
  {
    name: 'consent',
    duration: '365 days',
    category: 'necessary',
    purpose: 'Remembers the choice you made in the consent banner, so it is not asked again ' +
      'on every page visit.',
  },
  {
    name: 'gid',
    duration: '365 days',
    category: 'analytics',
    purpose: 'First-party guest identity: repeat visits from one browser count as one visitor ' +
      'in the analytics rollups instead of many.',
  },
  {
    name: 'guest_fp',
    duration: '365 days',
    category: 'analytics',
    purpose: 'Deduplication key derived from device characteristics, so a visitor who clears ' +
      'cookies does not become a new guest record.',
  },
  {
    name: 'aid',
    duration: '90 days',
    category: 'analytics',
    purpose: 'Attribution context kept by the app (first touch, campaign, referral) so it can ' +
      'be attributed when a guest later signs up.',
  },
  {
    name: '_ga, _ga_<id>',
    duration: '2 years',
    category: 'analytics',
    purpose: 'Google Analytics 4: distinguishes visitors and sessions, at Google\'s default ' +
      'retention. Set by Google, and only after you grant analytics consent.',
  },
  {
    name: 'device_id',
    duration: '365 days',
    category: 'functional',
    purpose: 'Trusted-device token: a device you already verified can skip the email ' +
      'verification code on later sign-ins.',
  },
]
