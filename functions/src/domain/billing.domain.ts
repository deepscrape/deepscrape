/* eslint-disable max-len */
export type BillingPlanTier = "free" | "trial" | "starter" | "pro" | "enterprise"
export type BillingInterval = "payAsYouGo" | "monthly" | "quarterly" | "annually"
export type BillingAccessMode = "free" | "credits" | "plan" | "grace"
export type CreditBucket = "purchased" | "included"

export type BillingCredits = {
  balance?: number
  reserved?: number
  purchasedBalance?: number
  purchasedReserved?: number
  includedBalance?: number
  includedReserved?: number
}

export type BillingSnapshot = {
  plan?: string | BillingPlanTier | null
  subscriptionId?: string | null
  graceUntil?: string | null
  credits?: BillingCredits | null
}

const paidPlans = new Set<BillingPlanTier>(["trial", "starter", "pro", "enterprise"])

export const normalizeBillingPlan = (plan: string | BillingPlanTier | null | undefined): BillingPlanTier => {
  switch (plan) {
  case "trial":
  case "starter":
  case "pro":
  case "enterprise":
  case "free":
    return plan
  default:
    return "free"
  }
}

export const isPaidPlan = (plan: string | BillingPlanTier | null | undefined): boolean => {
  return paidPlans.has(normalizeBillingPlan(plan))
}

export const hasGraceAccess = (billing: BillingSnapshot | undefined, now = Date.now()): boolean => {
  return Boolean(billing?.graceUntil) && now < new Date(billing?.graceUntil as string).getTime()
}

/** Months each paid interval covers. `payAsYouGo` is a one-off credit purchase, not recurring. */
export const INTERVAL_MONTHS: Record<BillingInterval, number> = {
  monthly: 1,
  quarterly: 3,
  annually: 12,
  payAsYouGo: 0,
}

/**
 * Monthly-normalised value of a recurring list price, in EUR minor units.
 *
 * List price, not cash collected: a `quarterly` €27.99 plan is €9.33 of MRR every
 * month whether or not the invoice has been paid yet. One-off credit packs and
 * unknown intervals contribute 0. Unrounded on purpose — rounding per account
 * would multiply into the total — so callers round once, at the sum.
 *
 * @param {unknown} amountEur List price for the interval, in minor units.
 * @param {string | null | undefined} interval Billed interval.
 * @return {number} Monthly equivalent in minor units; 0 when not recurring.
 */
export const monthlyRecurringAmountEur = (amountEur: unknown, interval: string | null | undefined): number => {
  const months = INTERVAL_MONTHS[interval as BillingInterval] ?? 0
  const amount = Number(amountEur)

  if (!months || !Number.isFinite(amount) || amount <= 0) {
    return 0
  }

  return amount / months
}

/** Per-account billing state as persisted by the subscription webhook handlers. */
export type BillingAccountRow = {
  plan?: string | null
  planInterval?: string | null
  status?: string | null
  trialEndsAt?: string | null
  trialPlanTarget?: string | null
}

export type BillingMetrics = {
  payingAccounts: number
  activeTrials: number
  pastDueAccounts: number
  /** Recurring list price of every paying account, monthly-normalised, in minor units. */
  mrrEurMinor: number
  planMix: Record<string, number>
  /** Monthly list price the active trials would add if they all convert. */
  trialPipelineEurMinor: number
}

/** Statuses where Stripe has stopped billing: keep them out of MRR. */
const deadStatuses = new Set(["canceled", "unpaid", "incomplete_expired"])

/**
 * Aggregate per-account billing state into the numbers an operator acts on.
 *
 * Pure and price-injected so the money math is testable without Stripe. A missing
 * `status` counts as paying: rows written before the status field existed are
 * legacy active subscriptions, and dropping them would understate MRR.
 *
 * @param {BillingAccountRow[]} rows One row per account, as stored on the user document.
 * @param {Function} priceFor `(plan, interval) => amount`: list price lookup in minor units.
 * @param {number} nowMs Current epoch ms, for trial expiry.
 * @return {BillingMetrics} MRR, plan mix, trials and payment risk at this instant.
 */
export const computeBillingMetrics = (
  rows: BillingAccountRow[],
  priceFor: (plan: BillingPlanTier, interval: BillingInterval) => number,
  nowMs: number,
): BillingMetrics => {
  const planMix: Record<string, number> = {}
  let payingAccounts = 0
  let activeTrials = 0
  let pastDueAccounts = 0
  let mrrEurMinor = 0
  let trialPipelineEurMinor = 0

  for (const row of rows) {
    const plan = normalizeBillingPlan(row.plan)
    planMix[plan] = (planMix[plan] || 0) + 1

    if (plan === "trial") {
      const endsAt = row.trialEndsAt ? new Date(row.trialEndsAt).getTime() : Number.NaN
      if (!Number.isFinite(endsAt) || endsAt > nowMs) {
        activeTrials += 1
        // The target plan is what they convert to; price it monthly since the
        // interval they will pick is unknown at trial time.
        const target = normalizeBillingPlan(row.trialPlanTarget)
        if (isPaidPlan(target)) {
          trialPipelineEurMinor += priceFor(target, "monthly")
        }
      }
      continue
    }

    if (!isPaidPlan(plan)) {
      continue
    }

    if (String(row.status || "").trim().toLowerCase() === "past_due") {
      pastDueAccounts += 1
    }

    if (deadStatuses.has(String(row.status || "").trim().toLowerCase())) {
      continue
    }

    payingAccounts += 1
    mrrEurMinor += monthlyRecurringAmountEur(
      priceFor(plan, row.planInterval as BillingInterval),
      row.planInterval,
    )
  }

  return {
    payingAccounts,
    activeTrials,
    pastDueAccounts,
    mrrEurMinor,
    planMix,
    trialPipelineEurMinor,
  }
}

export const getLegacyCreditBucket = (billing: BillingSnapshot | undefined): CreditBucket => {
  return normalizeBillingPlan(billing?.plan) === "free" ? "purchased" : "included"
}

export const getCreditAmounts = (
  billing: BillingSnapshot | undefined,
  bucket: CreditBucket,
): { balance: number; reserved: number } => {
  const credits = billing?.credits
  const legacyBalance = Number(credits?.balance || 0)
  const legacyReserved = Number(credits?.reserved || 0)

  if (bucket === "purchased") {
    if (credits?.purchasedBalance !== undefined || credits?.purchasedReserved !== undefined) {
      return {
        balance: Number(credits?.purchasedBalance || 0),
        reserved: Number(credits?.purchasedReserved || 0),
      }
    }

    return getLegacyCreditBucket(billing) === "purchased" ?
      {balance: legacyBalance, reserved: legacyReserved} :
      {balance: 0, reserved: 0}
  }

  if (credits?.includedBalance !== undefined || credits?.includedReserved !== undefined) {
    return {
      balance: Number(credits?.includedBalance || 0),
      reserved: Number(credits?.includedReserved || 0),
    }
  }

  return getLegacyCreditBucket(billing) === "included" ?
    {balance: legacyBalance, reserved: legacyReserved} :
    {balance: 0, reserved: 0}
}

export const getPurchasedCreditsAvailable = (billing: BillingSnapshot | undefined): number => {
  const credits = getCreditAmounts(billing, "purchased")
  return Math.max(0, credits.balance - credits.reserved)
}

export const getIncludedCreditsAvailable = (billing: BillingSnapshot | undefined): number => {
  const credits = getCreditAmounts(billing, "included")
  return Math.max(0, credits.balance - credits.reserved)
}

export const canPurchaseStandaloneCredits = (billing: BillingSnapshot | undefined): boolean => {
  return normalizeBillingPlan(billing?.plan) === "free" && !billing?.subscriptionId
}

export const getBillingAccessMode = (billing: BillingSnapshot | undefined, now = Date.now()): BillingAccessMode => {
  if (isPaidPlan(billing?.plan)) {
    return "plan"
  }

  if (normalizeBillingPlan(billing?.plan) === "free" && getPurchasedCreditsAvailable(billing) > 0) {
    return "credits"
  }

  if (hasGraceAccess(billing, now)) {
    return "grace"
  }

  return "free"
}

export const hasBillingAccess = (billing: BillingSnapshot | undefined, now = Date.now()): boolean => {
  return getBillingAccessMode(billing, now) !== "free"
}
