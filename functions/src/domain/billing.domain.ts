/* eslint-disable max-len */
export type BillingPlanTier = "free" | "trial" | "starter" | "pro" | "enterprise"
export type BillingInterval = "payAsYouGo" | "monthly" | "quarterly" | "annually"
export type BillingAccessMode = "free" | "credits" | "plan" | "grace" | "unlimited"
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
  /**
   * The interval the plan was bought on.
   *
   * `payAsYouGo` is the only value that grants access for a FIXED WINDOW rather
   * than until a subscription lapses, because it is paid once and has no renewal
   * to carry it forward.
   */
  planInterval?: BillingInterval | string | null
  /** When the current period ends. Authoritative for a `payAsYouGo` window. */
  currentPeriodEnd?: string | null
  graceUntil?: string | null
  /**
   * The Stripe subscription status, as stored on the billing document.
   *
   * Absent on documents written before it was recorded, and those are treated as
   * paying — the same rule the MRR metrics already use, so the two cannot disagree
   * about whether a legacy row is live.
   */
  status?: string | null
  credits?: BillingCredits | null
  /**
   * Sales-provisioned unmetered usage.
   *
   * Set by an operator on a negotiated agreement, never by a purchase. It only REFINES the
   * `plan` verdict: an unlimited flag on a lapsed plan grants nothing, because the validity
   * test still runs first.
   */
  unlimited?: boolean
  /**
   * When the granted window closes. Absent means "until revoked", which is what a term
   * contract wants — a pilot sets it so an unmetered account cannot quietly outlive the
   * deal that justified it.
   */
  unlimitedUntil?: string | null
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

/**
 * One `payAsYouGo` purchase, as a fraction of a monthly subscription.
 *
 * The price already is this fraction: starter EUR0.99 against EUR9.99, pro
 * EUR1.99 against EUR19.99. The credit grant already is this fraction too
 * (`getIncludedCreditsForPlanInterval`, `Math.round(monthly * 0.1)`). The third
 * thing that must be this fraction is the DURATION, and it was the missing one.
 */
export const PAYG_PRICE_FRACTION = 0.1

/** How long one `payAsYouGo` purchase grants access: 10% of a 30-day month. */
export const PAYG_ACCESS_DAYS = Math.round(30 * PAYG_PRICE_FRACTION)

/**
 * The instant a `payAsYouGo` purchase stops granting access.
 *
 * Ten such purchases for 30 days cost EUR19.90 against the EUR19.99 monthly, so
 * the two are the same product at the same rate -- one with no commitment and no
 * renewal. Derived from the same fraction as the credit grant so the money, the
 * credits and the window cannot drift apart.
 * @param {number} startMs Epoch ms of the payment.
 * @return {string} The ISO timestamp the window closes.
 */
export const paygAccessEndsAt = (startMs: number): string =>
  new Date(startMs + PAYG_ACCESS_DAYS * 24 * 60 * 60 * 1000).toISOString()

/**
 * Whether a `payAsYouGo` window has closed.
 *
 * FAILS CLOSED, and that direction is deliberate rather than defensive. A
 * `payAsYouGo` row with no `currentPeriodEnd` is precisely what the writer
 * produced before this existed: it wrote `null` and relied on nothing checking.
 * Reading a missing date as "still valid" would preserve the defect for exactly
 * the rows it created, so a missing or unparseable date counts as closed.
 *
 * A subscription is untouched by this: Stripe sends its own `current_period_end`
 * and its status is what lapses it, so `isPaidPlan` remains the whole test for
 * every interval except `payAsYouGo`.
 * @param {BillingSnapshot} billing The caller's billing snapshot.
 * @param {number} now Epoch ms.
 * @return {boolean} True when a payg window has closed.
 */
export const isPaygWindowClosed = (
  billing: BillingSnapshot | undefined,
  now = Date.now(),
): boolean => {
  if (billing?.planInterval !== "payAsYouGo") {
    return false
  }

  const end = billing?.currentPeriodEnd
  if (typeof end !== "string" || end.length === 0) {
    return true
  }

  const endMs = new Date(end).getTime()
  return !Number.isFinite(endMs) || now >= endMs
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
  // `status` was never read here, and the plan NAME was the only input. Dunning
  // ends at `unpaid`, which matched neither the sweep's `past_due` nor `free`, so a
  // subscription that stopped paying kept full plan access forever. `past_due`
  // deliberately still grants `plan`: Stripe is retrying, and the sweep bounds it.
  const status = String(billing?.status || "").trim().toLowerCase()
  const agreementEnded =
    status === "unpaid" ||
    status === "incomplete" ||
    status === "incomplete_expired" ||
    status === "canceled"

  if (isPaidPlan(billing?.plan) && !agreementEnded && !isPaygWindowClosed(billing, now)) {
    // `unlimited` refines the verdict rather than replacing it, and that order is the whole
    // safety property: the validity test above already ran, so a flag left on a lapsed
    // account grants nothing. Every charging path asks `isChargeableAccessMode` next, and
    // that predicate names only `credits` and `plan` -- so returning this string is what
    // actually stops the meter, not the flag on its own.
    //
    // An unparseable end date counts as CLOSED, matching `isPaygWindowClosed`: a grant with
    // a date nobody can read is not one to keep honouring.
    const unlimitedUntil = billing?.unlimitedUntil
    const unlimitedLive = billing?.unlimited === true &&
      (!unlimitedUntil || now < new Date(unlimitedUntil).getTime())

    return unlimitedLive ? "unlimited" : "plan"
  }

  // Purchased credits OUTLIVE the plan they were bought beside.
  //
  // This used to require `plan === "free"`, which stranded credits the moment a
  // plan stopped being valid without changing its name -- exactly what an expired
  // `payAsYouGo` window does, since the stored plan still reads "pro". A
  // subscription never reaches here (the branch above returns first), so
  // dropping that condition widens nothing except the case it was wrong for.
  if (getPurchasedCreditsAvailable(billing) > 0) {
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

/**
 * Whether an entitlement is one the platform BILLS.
 *
 * `requirePaidAccess` decides this while charging, and the pricing estimate has
 * to answer the same question before a call, so the predicate lives here rather
 * than being re-spelled as `accessMode === "credits" || accessMode === "plan"` in
 * more than one place. `free` and `grace` are deliberately excluded: neither has
 * credits to spend, so charging them would drive a wallet negative.
 *
 * `unlimited` is excluded for the opposite reason: it is an entitlement a person
 * granted, and there is no wallet it should draw down. Adding it to this list is
 * the ONLY thing that would start billing an unlimited account, which is why the
 * list is explicit rather than `accessMode !== "free"`.
 * @param {string|undefined} accessMode The mode `resolveAccess` resolved.
 * @return {boolean} True when a call under this mode is charged.
 */
export const isChargeableAccessMode = (accessMode: string | undefined): boolean => {
  return accessMode === "credits" || accessMode === "plan"
}
