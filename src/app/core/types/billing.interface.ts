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
  unitAmount: number
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

export type BillingUsageStats = {
  currentUsage: number
  usageCap: number
  includedCredits: number
  purchasedCredits: number
  creditsUsedInRange: number
  /** Per-capability credit totals for the same window. Optional: older payloads omit it. */
  metered?: BillingUsageMeter[]
}

export type BillingUsageResponse = {
  range: BillingUsageRange
  summary: BillingUsageSummary
  usage: BillingUsageStats
  invoices: BillingUsageInvoice[]
  payments: BillingUsagePayment[]
  breakdown: BillingUsageBreakdownItem[]
}
