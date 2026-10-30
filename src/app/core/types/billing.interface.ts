export type BillingPlanTier = "free" | "trial" | "starter" | "pro" | "enterprise"

export type BillingInterval = "payAsYouGo" | "monthly" | "quarterly" | "annually"

export type BillingPriceConfig = {
  amount: number
  currency: "eur"
  stripePriceId?: string
  includedCredits?: number
}

export type BillingPlanCatalog = {
  id: BillingPlanTier
  label: string
  description: string
  features: string[]
  /**
   * Only the intervals this plan is actually sold on.
   *
   * Partial because "not sold this way" is a real state: Enterprise has no pay-as-you-go
   * price at all, and reading `prices.payAsYouGo.amount` would be a crash rather than a
   * zero. Every read must therefore go through `?.`.
   */
  prices: Partial<Record<BillingInterval, BillingPriceConfig>>
  /** Arranged with sales: no checkout, no price on the card, a conversation instead. */
  salesLed?: boolean
  /** Sales-provisioned unmetered usage. Reflects the entitlement, it does not grant it. */
  unlimited?: boolean
}

export type CreditPackCatalog = {
  id: string
  label: string
  credits: number
  amount: number
  currency: "eur"
  stripePriceId?: string
}

export type CustomCreditsCatalog = {
  enabled: boolean
  minimumCredits: number
  maximumCredits: number
  currency: "eur"
  suggestedCredits: number[]
}

export type BillingAccessMode = 'free' | 'credits' | 'plan' | 'grace'

export type UserBilling = {
  plan: BillingPlanTier
  status: string
  subscriptionId: string | null
  planInterval?: BillingInterval | null
  cancelAtPeriodEnd?: boolean
  cancelAt?: string | null
  currentPeriodStart?: string | null
  currentPeriodEnd?: string | null
  graceUntil: string | null
  trialPlanTarget?: BillingPlanTier | null
  trialStartedAt?: string | null
  trialEndsAt?: string | null
  trialUsedAt?: string | null
  trialCreditCapEur?: number
  /** When the next purchased-credit batch stops being spendable, from the server. */
  creditsExpireAt?: string | null
  /** Set while a payment dispute is open; spending is refused until it clears. */
  hold?: boolean | null
  credits: {
    balance: number
    reserved: number
    purchasedBalance?: number
    purchasedReserved?: number
    includedBalance?: number
    includedReserved?: number
  }
  features: Record<string, boolean>
  updatedAt?: unknown
}

export type BillingCatalogPayload = {
  plans: BillingPlanCatalog[]
  creditPacks: CreditPackCatalog[]
  customCredits: CustomCreditsCatalog
  periods: BillingInterval[]
  currency: "eur"
}

export type EnterprisePlanRequestPayload = {
  contactEmail: string
  workspaceName?: string
  selectedPlan?: BillingPlanTier | null
  /** Which surface asked. Omitted means onboarding, for older callers. */
  source?: 'service_onboarding' | 'billing_plans'
}

export type BillingLoadingState = {
  checkout: boolean
  portal: boolean
  trial: boolean
  resumeCancellation: boolean
  usageReport: boolean
}

export type BillingUsageRangeKey = "this_month" | "last_month" | "last_30_days" | "last_90_days"

export type BillingUsageGrouping = "day" | "hour"

export type BillingUsageRequest = {
  range?: BillingUsageRangeKey
}

export type BillingUsageRange = {
  key: BillingUsageRangeKey
  label: string
  start: string
  end: string
  grouping: BillingUsageGrouping
}

export type BillingUsageSummary = {
  currency: string
  totalInvoiced: number
  totalPaid: number
}

export type BillingUsageInvoice = {
  id: string
  number: string | null
  status: string | null
  total: number
  amountPaid: number
  currency: string
  periodStart: string | null
  periodEnd: string | null
  createdAt: string
  hostedInvoiceUrl: string | null
}

export type BillingUsagePayment = {
  id: string
  status: string
  amount: number
  currency: string
  createdAt: string
  description: string | null
}

export type BillingUsageBreakdownItem = {
  id: string
  date: string
  source: "invoice_line" | "payment"
  category: string
  description: string
  quantity: number | null
  unitAmount: number | null
  total: number
  currency: string
  referenceId: string
}

export type BillingUsageMeter = {
  key: string
  credits: number
  events: number
  /**
   * Distinct machines behind these events. Only the session meter records a machine
   * id, so request-priced capabilities report 0 (and rows written before the field
   * existed report 0 too) — which is why the page renders it only when positive.
   */
  machines?: number
}

/** One machine's share of the period. Only session time records a machine id. */
export type BillingUsageMachine = {
  machineId: string
  credits: number
  events: number
}

export type BillingUsageStats = {
  currentUsage: number
  usageCap: number
  includedCredits: number
  purchasedCredits: number
  creditsUsedInRange: number
  /** Per-capability credit totals for the same window. Optional: older payloads omit it. */
  metered?: BillingUsageMeter[]
  /**
   * The same ledger rows, ordered by UTC day, for the history chart.
   *
   * Sparse: a day with no activity is absent rather than zero, so fill gaps from
   * the range when a continuous axis is needed. Optional for the same reason as
   * `metered` — an older deployment does not send it.
   */
  series?: BillingUsageDay[]
  /** Subscription versus pay-as-you-go for this window. Optional: older payloads omit it. */
  savings?: BillingPlanSavings
  /** The browser fleet's bill, dearest machine first. Optional for the same reason. */
  machines?: BillingUsageMachine[]
}

/** One day of the reporting window. */
export type BillingUsageDay = {
  /** UTC `YYYY-MM-DD`. */
  date: string
  credits: number
  events: number
}

/**
 * What the plan saved against buying the same credits as packs.
 *
 * Computed by `estimatePlanSavings` from the same two catalogs checkout uses.
 * `savingMinor` is SIGNED: a quiet month on a paid plan is negative, and
 * pretending otherwise would be a claim the till does not support.
 */
export type BillingPlanSavings = {
  /** The period's credits at pack rates, in minor units. */
  payAsYouGoMinor: number
  /** What the plan cost for the same period, in minor units. */
  planMinor: number
  /** `payAsYouGoMinor - planMinor`. */
  savingMinor: number
  /** Signed percentage of the pay-as-you-go figure; 0 when there was no usage. */
  savingPercent: number
}

export type BillingUsageResponse = {
  range: BillingUsageRange
  summary: BillingUsageSummary
  usage: BillingUsageStats
  invoices: BillingUsageInvoice[]
  payments: BillingUsagePayment[]
  breakdown: BillingUsageBreakdownItem[]
}
