/**
 * How long the resend button stays disabled after a verification email the provider ACCEPTED.
 *
 * Five minutes, inside the 5-10 the product asked for and far below Firebase's own hourly quota,
 * so the UI refuses first and the user never meets a rate-limit error they cannot act on.
 */
export const RESEND_COOLDOWN_MS = 5 * 60 * 1000

/**
 * Where the last accepted send is stamped, per account.
 *
 * Per uid rather than one global key: two accounts signing in on the same browser must not
 * silence each other's resend button. Local storage rather than component state so a refresh --
 * or the trip from signup to this screen -- cannot defeat the cooldown.
 * @param {string} uid The account the stamp belongs to.
 * @return {string} The storage key.
 */
export const resendStampKey = (uid: string): string => `verify-email-sent:${uid}`

/**
 * Milliseconds left before another verification email may be sent.
 *
 * Driven by a stamp written ONLY when the provider accepted the send, which is what keeps the
 * button enabled after a failure: a send that did not happen must be retryable immediately, and
 * a cooldown there would hide the failure behind a disabled control.
 *
 * Note what "accepted" means: the provider queued the email. No client can observe delivery into
 * an inbox, so this is the strongest signal available and the UI should not claim more.
 * @param {number | null} stamp Epoch ms of the last accepted send, or null when there is none.
 * @param {number} now Current epoch ms, injectable so the rule is testable.
 * @return {number} Milliseconds remaining, `0` when a send is allowed now.
 */
export function resendWaitMs(stamp: number | null, now: number = Date.now()): number {
  if (!stamp) {
    return 0
  }

  const left = stamp + RESEND_COOLDOWN_MS - now

  if (left <= 0) {
    return 0
  }

  // A stamp in the future is a wrong clock, not a longer cooldown. Clamped, so it can never hold
  // the button for longer than one fresh send would.
  return Math.min(left, RESEND_COOLDOWN_MS)
}

/**
 * A countdown as `m:ss`, for the label on a button that cannot be pressed yet.
 * @param {number} ms Milliseconds remaining.
 * @return {string} Minutes and zero-padded seconds, e.g. `4:07`.
 */
export function formatWait(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60

  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
