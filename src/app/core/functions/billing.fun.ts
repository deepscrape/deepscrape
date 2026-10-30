/**
 * Whether a subscription has stopped paying.
 *
 * A plan NAME is not entitlement. This mirrors `getBillingAccessMode` in
 * `functions/src/domain/billing.domain.ts`, which refuses access for exactly these
 * statuses even while `plan` still reads "pro" — so without this the plans page
 * showed "Pro · current plan" to a customer every paid route answers 402 for.
 *
 * `past_due` is deliberately absent: Stripe is still retrying and the sweep bounds
 * it, so access stands. The two lists must stay in step; the server is the authority
 * and this is only the label the UI puts on its verdict.
 */
const ENDED_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'canceled',
])

/**
 * True when billing says the agreement ended while the plan name lingers.
 * @param {string | null | undefined} status Stripe's subscription status.
 * @return {boolean} Whether the customer must act to restore access.
 */
export const isDunning = (status?: string | null): boolean =>
  ENDED_SUBSCRIPTION_STATUSES.has(String(status || '').trim().toLowerCase())
