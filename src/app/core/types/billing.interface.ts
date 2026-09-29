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
  prices: Record<BillingInterval, BillingPriceConfig>
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

export type BillingUsageStats = {
  currentUsage: number
  usageCap: number
  includedCredits: number
  purchasedCredits: number
  creditsUsedInRange: number
}

export type BillingUsageResponse = {
  range: BillingUsageRange
  summary: BillingUsageSummary
  usage: BillingUsageStats
  invoices: BillingUsageInvoice[]
  payments: BillingUsagePayment[]
  breakdown: BillingUsageBreakdownItem[]
}
