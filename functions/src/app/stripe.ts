/* eslint-disable object-curly-spacing */
/* eslint-disable max-len */
/* eslint-disable indent */
// Takes a Firebase user and creates a Stripe customer account
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import {
  db,
  dbName,
  auth as adminAuth,
  stripeSecrets,
  stripeTestSecrets,
  getStripe,
  getStripeWebhookSecret,
} from "./config"
import { grantBillingCredits } from "./billing-credits"
import type { UserInfo } from "firebase-admin/auth"
import { FieldValue } from "firebase-admin/firestore"
import { onDocumentCreated } from "firebase-functions/v2/firestore"
import { HttpsError, onRequest, type HttpsFunction, type Request } from "firebase-functions/v2/https"
import type { SecretParam } from "firebase-functions/params"
// ponytail: all ~25 billing callables now go through the per-UID budget. Aliased so
// not one of the definitions below changes. The Express limiters never see an
// onCall, so createPaymentIntent/createCheckoutSession were unbounded per account.
import { guardedOnCall as onCallv2 } from "../infrastructure/callable-limiter"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { Users, Guest, ANALYTICS_EVENTS, buildAnalyticsEvent, canPurchaseStandaloneCredits, getPurchasedCreditsAvailable, toEventHour, toPaidCounterKeys } from "../domain"
import Stripe from "stripe"
import { env } from "../config/env"
import { findUnusableCatalogPrices, lookupKeyForCredits, lookupKeyForPlan, resolvePriceId } from "./stripe-price-resolution"
import { lookupGeoByIp } from "../gfunctions/analytics"

type BillingPlanTier = "free" | "trial" | "starter" | "pro" | "enterprise"
type BillingInterval = "payAsYouGo" | "monthly" | "quarterly" | "annually"

const isBillingInterval = (value: string): value is BillingInterval => {
  return value === "payAsYouGo" || value === "monthly" || value === "quarterly" || value === "annually"
}

const getIntervalMonths = (interval: Stripe.Price.Recurring.Interval, count: number): number => {
  return interval === "year" ? count * 12 : count
}

type BillingPriceConfig = {
  amount: number
  currency: "eur"
  stripePriceId?: string
  includedCredits?: number
}

type BillingPlanCatalog = {
  id: BillingPlanTier
  label: string
  description: string
  features: string[]
  prices: Record<BillingInterval, BillingPriceConfig>
}

type CreditPackCatalog = {
  id: string
  label: string
  credits: number
  amount: number
  currency: "eur"
  stripePriceId?: string
}

type CustomCreditsCatalog = {
  enabled: boolean
  minimumCredits: number
  maximumCredits: number
  unitAmount: number
  currency: "eur"
  suggestedCredits: number[]
}

type UserBilling = {
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
  updatedAt: FirebaseFirestore.FieldValue
}

const usageThresholds = [0.7, 0.9, 1]

const usageCapsByPlan: Record<BillingPlanTier, number> = {
  free: 100,
  trial: 5000,
  starter: 1000,
  pro: 5000,
  enterprise: 20000,
}

const recurringCreditGrantReasons = new Set(["subscription_create", "subscription_cycle"])

const getIncludedCreditsForPlanInterval = (plan: BillingPlanTier, interval: BillingInterval): number => {
  if (plan === "free") {
    return 0
  }

  if (plan === "trial") {
    return TRIAL_DEFAULT_CREDITS
  }

  const monthlyCredits = usageCapsByPlan[plan]
  if (!monthlyCredits) {
    return 0
  }

  switch (interval) {
  case "payAsYouGo":
    return Math.max(1, Math.round(monthlyCredits * 0.1))
  case "quarterly":
    return monthlyCredits * 3
  case "annually":
    return monthlyCredits * 12
  case "monthly":
  default:
    return monthlyCredits
  }
}

const buildBillingPriceConfig = (
  plan: BillingPlanTier,
  interval: BillingInterval,
  amount: number,
  stripePriceId?: string,
): BillingPriceConfig => ({
  amount,
  currency: "eur",
  stripePriceId,
  includedCredits: getIncludedCreditsForPlanInterval(plan, interval),
})

const addCreditsLedgerEntry = async (args: {
  uid: string
  delta: number
  source: string
  bucket?: "purchased" | "included"
  grantedBy?: string
  reason?: string
  sessionId?: string
  paymentIntentId?: string
  invoiceId?: string
  subscriptionId?: string | null
  plan?: BillingPlanTier
  interval?: BillingInterval
  createdAt?: FirebaseFirestore.FieldValue
}) => {
  const normalizedDelta = Math.floor(args.delta)
  if (!Number.isFinite(normalizedDelta) || normalizedDelta <= 0) {
    return
  }

  const bucket = args.bucket || "purchased"
  const idempotencyKey = args.invoiceId ? `invoice:${args.invoiceId}:${bucket}:${args.reason || args.source}` :
    args.paymentIntentId ? `payment_intent:${args.paymentIntentId}:${bucket}:${args.reason || args.source}` :
      args.sessionId ? `session:${args.sessionId}:${bucket}:${args.reason || args.source}` :
        null

  await grantBillingCredits({
    uid: args.uid,
    amount: normalizedDelta,
    bucket,
    ledger: {
      source: args.source,
      reason: args.reason || null,
      grantedBy: args.grantedBy || null,
      sessionId: args.sessionId || null,
      paymentIntentId: args.paymentIntentId || null,
      invoiceId: args.invoiceId || null,
      subscriptionId: args.subscriptionId || null,
      plan: args.plan || null,
      interval: args.interval || null,
      createdAt: args.createdAt || FieldValue.serverTimestamp(),
      idempotencyKey,
    },
  })
}

// Both identifiers for an invoice's recurring price. `lookupKey` is the portable one.
export type InvoicePriceRef = { id: string | null, lookupKey: string | null }

// Exported for the spec: this is the mapping production silently failed to match.
export const getInvoiceRecurringPrice = (invoice: Stripe.Invoice): InvoicePriceRef | null => {
  const lines = invoice.lines?.data || []

  for (const line of lines) {
    const lineWithPrice = line as Stripe.InvoiceLineItem & {
      price?: Stripe.Price | null
      pricing?: {
        price_details?: {
          price?: string | Stripe.Price | null
        }
      }
    }

    if (lineWithPrice.price?.id) {
      return { id: lineWithPrice.price.id, lookupKey: lineWithPrice.price.lookup_key || null }
    }

    const pricingPrice = lineWithPrice.pricing?.price_details?.price
    if (typeof pricingPrice === "string") {
      return { id: pricingPrice, lookupKey: null }
    }

    if (pricingPrice && typeof pricingPrice === "object" && "id" in pricingPrice) {
      return { id: pricingPrice.id, lookupKey: pricingPrice.lookup_key || null }
    }
  }

  return null
}

const toPositiveInteger = (value: string, fallback: number): number => {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const TRIAL_PERIOD_DAYS = toPositiveInteger(env.STRIPE_TRIAL_PERIOD_DAYS, 14)
const TRIAL_DEFAULT_CREDITS = toPositiveInteger(env.BILLING_TRIAL_DEFAULT_CREDITS, 160)
const TRIAL_DEFAULT_CREDIT_CAP_EUR = toPositiveInteger(env.BILLING_TRIAL_DEFAULT_CREDIT_CAP_EUR, 160)
const CUSTOM_CREDITS_MIN = toPositiveInteger(env.BILLING_CUSTOM_CREDITS_MIN, 50)
const CUSTOM_CREDITS_MAX = toPositiveInteger(env.BILLING_CUSTOM_CREDITS_MAX, 5000)
const CUSTOM_CREDIT_UNIT_AMOUNT_EUR = toPositiveInteger(env.BILLING_CUSTOM_CREDIT_UNIT_AMOUNT_EUR, 19)
const BILLING_RESTRICTED_ROLE_KEYWORDS = ["manager", "editor"]
const billingAllowedOrigins = env.IS_PRODUCTION ?
  ["https://deepscrape.dev", "https://deepscrape.web.app"] :
  [
    "http://localhost:5000",
    "http://127.0.0.1:5000",
    "http://localhost:4200",
    "http://127.0.0.1:4200",
    "http://127.0.0.1:8081",
  ]

const customCreditsCatalog: CustomCreditsCatalog = {
  enabled: true,
  minimumCredits: CUSTOM_CREDITS_MIN,
  maximumCredits: CUSTOM_CREDITS_MAX,
  unitAmount: CUSTOM_CREDIT_UNIT_AMOUNT_EUR,
  currency: "eur",
  suggestedCredits: [100, 250, 500, 1000].filter((credits) => credits >= CUSTOM_CREDITS_MIN && credits <= CUSTOM_CREDITS_MAX),
}

const assertCreditModeAllowed = (billing: Pick<UserBilling, "plan" | "subscriptionId"> | undefined): void => {
  if (!canPurchaseStandaloneCredits(billing)) {
    throw new HttpsError(
      "failed-precondition",
      "Credit purchases are only available on the free plan. Active subscribers cannot buy or use standalone credits at the same time.",
    )
  }
}

const normalizeRole = (role: string | null | undefined): string => {
  return (role || "").trim().toLowerCase()
}

const isPlatformAdminRole = (role: string | null | undefined): boolean => {
  return normalizeRole(role) === "admin"
}

const isBillingRestrictedRole = (role: string | null | undefined): boolean => {
  const normalized = normalizeRole(role)
  if (!normalized) {
    return false
  }

  return BILLING_RESTRICTED_ROLE_KEYWORDS.some((keyword) => normalized === keyword || normalized.includes(keyword))
}

const isBillingRestrictedUser = (user: Users | undefined, tokenRole?: string | null): boolean => {
  if (isPlatformAdminRole(tokenRole) || isPlatformAdminRole(user?.role)) {
    return false
  }

  if (isBillingRestrictedRole(tokenRole)) {
    return true
  }

  return isBillingRestrictedRole(user?.role)
}

const getTokenRole = (req: { auth?: { token?: unknown } }): string | null => {
  const token = req.auth?.token as { role?: unknown } | undefined
  const role = token?.role
  return typeof role === "string" ? role : null
}

const assertAllowedReturnUrl = (url: string, fieldName: string): void => {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    throw new HttpsError("invalid-argument", `${fieldName} must be a valid absolute URL`)
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HttpsError("invalid-argument", `${fieldName} must use http or https`)
  }

  const origin = parsed.origin
  if (!billingAllowedOrigins.includes(origin)) {
    throw new HttpsError("permission-denied", `${fieldName} origin is not allowed`)
  }
}

const assertBillingAllowed = (user: Users | undefined, tokenRole?: string | null): void => {
  if (isBillingRestrictedUser(user, tokenRole)) {
    throw new HttpsError("permission-denied", "Billing is disabled for manager and editor accounts")
  }
}

const hasTrialExpired = (billing: UserBilling | undefined): boolean => {
  if (!billing || billing.plan !== "trial" || !billing.trialEndsAt) {
    return false
  }

  const expiry = Date.parse(billing.trialEndsAt)
  return Number.isFinite(expiry) && expiry <= Date.now()
}

const buildFreePlanFromExpiredTrial = (billing: UserBilling | undefined): Partial<UserBilling> => {
  const nowIso = new Date().toISOString()
  return {
    ...getDefaultBillingForPlan("free"),
    plan: "free",
    status: "inactive",
    subscriptionId: null,
    planInterval: null,
    trialPlanTarget: null,
    trialStartedAt: billing?.trialStartedAt || null,
    trialEndsAt: billing?.trialEndsAt || null,
    trialUsedAt: billing?.trialUsedAt || billing?.trialEndsAt || nowIso,
    trialCreditCapEur: 0,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    updatedAt: FieldValue.serverTimestamp(),
  }
}

// FIX #3: Sync billing snapshot into user doc to eliminate subcollection reads on callable invocations.
// Full-state writes use set({billing: data}, {merge: true}) so the whole billing field is replaced.
const syncBillingToUserDoc = (
  userRef: FirebaseFirestore.DocumentReference,
  billing: Partial<UserBilling>,
): Promise<FirebaseFirestore.WriteResult> => {
  return userRef.set({ billing }, { merge: true })
}

const createAlertId = (type: string, windowId: string) => `${type}_${windowId}`

const toSafeErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return "unknown_error"
}

const isFirestoreFailedPrecondition = (error: unknown): boolean => {
  const candidate = error as { code?: unknown; message?: unknown }
  const code = Number(candidate?.code)
  const message = String(candidate?.message || "").toLowerCase()

  return code === 9 || message.includes("failed_precondition") || message.includes("missing index")
}

const timestampToMillis = (value: unknown): number => {
  if (value && typeof value === "object" && "toDate" in (value as Record<string, unknown>)) {
    const toDate = (value as { toDate: () => Date }).toDate
    if (typeof toDate === "function") {
      return toDate.call(value).getTime()
    }
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  return 0
}

const sortDocsByTimestampDesc = (
  docs: FirebaseFirestore.QueryDocumentSnapshot[],
  fieldPath: string,
): FirebaseFirestore.QueryDocumentSnapshot[] => {
  return [...docs].sort((a, b) => {
    const left = timestampToMillis(a.get(fieldPath))
    const right = timestampToMillis(b.get(fieldPath))
    return right - left
  })
}

const recordBillingIncident = async (args: {
  type: string
  severity: "info" | "warning" | "error"
  eventId?: string | null
  eventType?: string | null
  uid?: string | null
  /** Stable identifier for recurring checks, so they can find their own open incident. */
  source?: string
  message: string
  metadata?: Record<string, unknown>
}): Promise<void> => {
  await db.collection("billing_incidents").add({
    type: args.type,
    severity: args.severity,
    eventId: args.eventId || null,
    eventType: args.eventType || null,
    uid: args.uid || null,
    source: args.source || null,
    message: args.message,
    metadata: args.metadata || {},
    createdAt: FieldValue.serverTimestamp(),
  })
}

const timestampToIso = (value: unknown): string | null => {
  if (value && typeof value === "object" && "toDate" in (value as Record<string, unknown>)) {
    const toDate = (value as { toDate: () => Date }).toDate
    if (typeof toDate === "function") {
      return toDate.call(value).toISOString()
    }
  }

  return null
}

const emitUsageAlert = async (args: {
  uid: string
  alertId: string
  title: string
  message: string
  severity?: "info" | "warning" | "error"
  metadata?: Record<string, unknown>
}) => {
  const alertRef = db.doc(`users/${args.uid}/usage_alerts/${args.alertId}`)
  const exists = await alertRef.get()
  if (exists.exists) {
    return
  }

  await alertRef.set({
    title: args.title,
    message: args.message,
    severity: args.severity || "info",
    metadata: args.metadata || {},
    createdAt: FieldValue.serverTimestamp(),
    read: false,
  }, { merge: true })
}

/**
 * List prices per plan and interval, in EUR minor units. Exported so the
 * analytics snapshot can price subscriptions from the same numbers the checkout
 * charges -- a second copy would silently drift on the next price change.
 */
export const billingPlanCatalog: BillingPlanCatalog[] = [
  {
    id: "free",
    label: "Free",
    description: "Starter access for evaluation",
    features: ["basic_markdown", "single_project", "community_support"],
    prices: {
      payAsYouGo: buildBillingPriceConfig("free", "payAsYouGo", 0),
      monthly: buildBillingPriceConfig("free", "monthly", 0),
      quarterly: buildBillingPriceConfig("free", "quarterly", 0),
      annually: buildBillingPriceConfig("free", "annually", 0),
    },
  },
  {
    id: "trial",
    label: "Trial",
    description: `Time-limited Pro experience (${TRIAL_PERIOD_DAYS} days)`,
    features: ["structured_extraction", "session_reuse", "anti_bot", "identity_crawling", "high_concurrency", "priority_support"],
    prices: {
      payAsYouGo: buildBillingPriceConfig("trial", "payAsYouGo", 0),
      monthly: buildBillingPriceConfig("trial", "monthly", 0),
      quarterly: buildBillingPriceConfig("trial", "quarterly", 0),
      annually: buildBillingPriceConfig("trial", "annually", 0),
    },
  },
  {
    id: "starter",
    label: "Starter",
    description: "For solo operators and small teams",
    features: ["structured_extraction", "session_reuse", "starter_limits"],
    prices: {
      payAsYouGo: buildBillingPriceConfig("starter", "payAsYouGo", 99, env.STRIPE_PRICE_STARTER_PAYG || "price_1T7ZdGFVGcR0rD8f5BmilH75"),
      monthly: buildBillingPriceConfig("starter", "monthly", 999, env.STRIPE_PRICE_STARTER_MONTHLY || "price_1T7Zb1FVGcR0rD8fVTy5nza0"),
      quarterly: buildBillingPriceConfig("starter", "quarterly", 2799, env.STRIPE_PRICE_STARTER_QUARTERLY || "price_1T7ZauFVGcR0rD8f0RpYopcQ"),
      annually: buildBillingPriceConfig("starter", "annually", 9999, env.STRIPE_PRICE_STARTER_ANNUAL || "price_1T7Zb3FVGcR0rD8fJtlFvrct"),
    },
  },
  {
    id: "pro",
    label: "Pro",
    description: "High-throughput crawling and anti-bot support",
    features: ["anti_bot", "identity_crawling", "high_concurrency", "priority_support"],
    prices: {
      payAsYouGo: buildBillingPriceConfig("pro", "payAsYouGo", 199, env.STRIPE_PRICE_PRO_PAYG || "price_1T7ZdGFVGcR0rD8fuvNlSOok"),
      monthly: buildBillingPriceConfig("pro", "monthly", 1999, env.STRIPE_PRICE_PRO_MONTHLY || "price_1T7Zb5FVGcR0rD8ffyGz9ctg"),
      quarterly: buildBillingPriceConfig("pro", "quarterly", 5599, env.STRIPE_PRICE_PRO_QUARTERLY || "price_1T7ZbGFVGcR0rD8f26jtWDAB"),
      annually: buildBillingPriceConfig("pro", "annually", 19999, env.STRIPE_PRICE_PRO_ANNUAL || "price_1T7ZbGFVGcR0rD8fFUWUNcsN"),
    },
  },
  {
    id: "enterprise",
    label: "Enterprise",
    description: "Custom limits, governance and dedicated support",
    features: ["sso", "audit_logs", "dedicated_support", "custom_limits"],
    prices: {
      payAsYouGo: buildBillingPriceConfig("enterprise", "payAsYouGo", 0),
      monthly: buildBillingPriceConfig("enterprise", "monthly", 4999, env.STRIPE_PRICE_ENTERPRISE_MONTHLY || "price_1T7ZbGFVGcR0rD8fAKK3YSEU"),
      quarterly: buildBillingPriceConfig("enterprise", "quarterly", 14999, env.STRIPE_PRICE_ENTERPRISE_QUARTERLY || "price_1T7ZbGFVGcR0rD8f1XhK9Y0g"),
      annually: buildBillingPriceConfig("enterprise", "annually", 49999, env.STRIPE_PRICE_ENTERPRISE_ANNUAL || "price_1T7ZbeFVGcR0rD8f5z7FBxNR"),
    },
  },
]

const creditPackCatalog: CreditPackCatalog[] = [
  { id: "credits_100", label: "100 credits", credits: 100, amount: 1900, currency: "eur", stripePriceId: env.STRIPE_PRICE_CREDITS_100 || "price_1T7ZbeFVGcR0rD8f0RRlAxOY" },
  { id: "credits_500", label: "500 credits", credits: 500, amount: 7900, currency: "eur", stripePriceId: env.STRIPE_PRICE_CREDITS_500 || "price_1T7ZbeFVGcR0rD8ffuQZ0XgM" },
  { id: "credits_2000", label: "2000 credits", credits: 2000, amount: 24900, currency: "eur", stripePriceId: env.STRIPE_PRICE_CREDITS_2000 || "price_1T7ZbeFVGcR0rD8fX73Nv2Cs" },
]

// Every price above carries a hardcoded TEST-mode price id (account
// acct_1Qag9KFVGcR0rD8f, `livemode: false`, verified against the Stripe API on
// 2026-09-20) when its env var is unset. Stripe ids do not cross modes, so these ids are
// now only a fallback: `createCheckoutSession` resolves the price by lookup_key first
// (see ./stripe-price-resolution), which is mode- and environment-independent. The id is
// what the resolver returns when the key is missing or Stripe is unreachable, so a
// mistake degrades to the previous behaviour instead of breaking checkout.
// This comment used to claim these were live ids, which inverted the risk and hid the
// fact that production had no catalog at all.
// The ids stay - removing them would turn a missing variable into a broken checkout in
// dev too - but the substitution must never be silent.
// This names exactly which variables are missing, once per cold start.
const PRICE_ENV_KEYS: Array<keyof typeof env> = [
  "STRIPE_PRICE_STARTER_PAYG", "STRIPE_PRICE_STARTER_MONTHLY",
  "STRIPE_PRICE_STARTER_QUARTERLY", "STRIPE_PRICE_STARTER_ANNUAL",
  "STRIPE_PRICE_PRO_PAYG", "STRIPE_PRICE_PRO_MONTHLY",
  "STRIPE_PRICE_PRO_QUARTERLY", "STRIPE_PRICE_PRO_ANNUAL",
  "STRIPE_PRICE_ENTERPRISE_MONTHLY", "STRIPE_PRICE_ENTERPRISE_QUARTERLY",
  "STRIPE_PRICE_ENTERPRISE_ANNUAL", "STRIPE_PRICE_CREDITS_100",
  "STRIPE_PRICE_CREDITS_500", "STRIPE_PRICE_CREDITS_2000",
]

const missingPriceEnv = PRICE_ENV_KEYS.filter((key) => !env[key])
if (missingPriceEnv.length) {
  console.warn(
    `[billing] price ids falling back to hardcoded test-mode ids: ${missingPriceEnv.join(", ")}. ` +
    "Checkout resolves the price by lookup_key first, so this only breaks if the account " +
    "also lacks those keys - which is exactly what production did. " +
    "Run validateStripeCatalog against the deployed environment.",
  )
}

const getFeaturesFromPlan = (plan: BillingPlanTier): Record<string, boolean> => {
  const allFeatures = [
    "basic_markdown",
    "single_project",
    "structured_extraction",
    "session_reuse",
    "anti_bot",
    "identity_crawling",
    "high_concurrency",
    "priority_support",
    "sso",
    "audit_logs",
    "dedicated_support",
    "custom_limits",
  ]

  const selected = billingPlanCatalog.find((item) => item.id === plan)?.features || []

  return allFeatures.reduce<Record<string, boolean>>((acc, feature) => {
    acc[feature] = selected.includes(feature)
    return acc
  }, {})
}

const getDefaultBillingForPlan = (plan: BillingPlanTier = "free"): UserBilling => {
  const defaultCredits = plan === "trial" ? TRIAL_DEFAULT_CREDITS : 0

  return {
    plan,
    status: plan === "free" ? "inactive" : "active",
    subscriptionId: null,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    graceUntil: null,
    trialPlanTarget: null,
    trialStartedAt: null,
    trialEndsAt: null,
    trialUsedAt: null,
    trialCreditCapEur: plan === "trial" ? TRIAL_DEFAULT_CREDIT_CAP_EUR : 0,
    credits: {
      balance: defaultCredits,
      reserved: 0,
      purchasedBalance: 0,
      purchasedReserved: 0,
      includedBalance: defaultCredits,
      includedReserved: 0,
    },
    features: getFeaturesFromPlan(plan),
    updatedAt: FieldValue.serverTimestamp(),
  }
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const submitEnterprisePlanRequest = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const uid = req.auth?.uid
    if (!uid) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const authUser = await adminAuth.getUser(uid)
    const fallbackEmail = (authUser.email || "").trim().toLowerCase()
    const providedEmail = typeof req.data?.contactEmail === "string" ? req.data.contactEmail.trim().toLowerCase() : ""
    const contactEmail = providedEmail || fallbackEmail

    if (!contactEmail || !EMAIL_REGEX.test(contactEmail)) {
      throw new HttpsError("invalid-argument", "A valid contact email is required")
    }

    const workspaceName = typeof req.data?.workspaceName === "string" ? req.data.workspaceName.trim().slice(0, 120) : ""
    const selectedPlan = typeof req.data?.selectedPlan === "string" ? req.data.selectedPlan : null
    const adminRecipients = env.ADMIN_EMAILS.map((item) => item.toLowerCase())

    await db.collection("admin_email_requests").add({
      kind: "enterprise_plan_request",
      uid,
      contactEmail,
      accountEmail: fallbackEmail || null,
      workspaceName: workspaceName || null,
      selectedPlan: selectedPlan || null,
      notifyAdmins: adminRecipients,
      status: "pending",
      source: "service_onboarding",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

    return { success: true }
  }
)

const mapPlanIdToTier = (planId: string): BillingPlanTier => {
  if (planId === "starter" || planId === "pro" || planId === "enterprise" || planId === "free" || planId === "trial") {
    return planId
  }

  return "free"
}

const inferPayAsYouGoPlanFromPayment = (args: {
  amount: number
  currency?: string | null
}): BillingPlanTier | null => {
  if (!Number.isFinite(args.amount) || args.amount <= 0) {
    return null
  }

  const currency = (args.currency || "").toLowerCase()
  const matches = billingPlanCatalog.filter((plan) => {
    if (plan.id === "free" || plan.id === "trial") {
      return false
    }

    const payg = plan.prices.payAsYouGo
    return payg.amount === args.amount && payg.currency.toLowerCase() === currency
  })

  if (matches.length !== 1) {
    return null
  }

  return matches[0].id
}

// Exported for the spec: the lookup_key-first match is what production got wrong.
export const inferRecurringPlanFromPriceId = (
  priceId: string | null | undefined,
  lookupKey?: string | null,
): {
  plan: BillingPlanTier
  interval: BillingInterval
} | null => {
  if (!priceId && !lookupKey) {
    return null
  }

  for (const plan of billingPlanCatalog) {
    if (plan.id === "free" || plan.id === "trial") {
      continue
    }

    const recurringIntervals: BillingInterval[] = ["monthly", "quarterly", "annually"]
    for (const interval of recurringIntervals) {
      const catalogPrice = plan.prices[interval]
      // lookup_key first: it is the only identifier that survives the test/live split.
      const matchesLookupKey = Boolean(lookupKey) && lookupKeyForPlan(plan.id, interval) === lookupKey
      if (matchesLookupKey || catalogPrice?.stripePriceId === priceId) {
        return {
          plan: plan.id,
          interval,
        }
      }
    }
  }

  console.error(
    `[billing] price ${priceId || "(none)"} / lookup_key ${lookupKey || "(none)"} matched no ` +
    "catalog price, so plan inference failed. Usually the account is missing the catalog, " +
    "or the lookup_key convention drifted.",
  )

  return null
}

type BillingUsageRangeKey =
  | "this_month"
  | "last_month"
  | "last_30_days"
  | "last_90_days"

type BillingUsageGrouping = "day" | "hour"

type BillingUsageWindow = {
  key: BillingUsageRangeKey
  label: string
  startMs: number
  endMs: number
  grouping: BillingUsageGrouping
}

const usageRangeLabels: Record<BillingUsageRangeKey, string> = {
  this_month: "This month",
  last_month: "Last month",
  last_30_days: "Last 30 days",
  last_90_days: "Last 90 days",
}

const asBillingUsageRangeKey = (value: unknown): BillingUsageRangeKey => {
  if (value === "this_month" || value === "last_month" || value === "last_30_days" || value === "last_90_days") {
    return value
  }

  return "this_month"
}

const resolveBillingUsageWindow = (rangeKey: BillingUsageRangeKey): BillingUsageWindow => {
  const now = new Date()
  const endMs = now.getTime()

  if (rangeKey === "this_month") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
    return {
      key: rangeKey,
      label: usageRangeLabels[rangeKey],
      startMs: start.getTime(),
      endMs,
      grouping: "day",
    }
  }

  if (rangeKey === "last_month") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0))
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
    return {
      key: rangeKey,
      label: usageRangeLabels[rangeKey],
      startMs: start.getTime(),
      endMs: end.getTime(),
      grouping: "day",
    }
  }

  if (rangeKey === "last_90_days") {
    return {
      key: rangeKey,
      label: usageRangeLabels[rangeKey],
      startMs: endMs - (90 * 24 * 60 * 60 * 1000),
      endMs,
      grouping: "day",
    }
  }

  return {
    key: "last_30_days",
    label: usageRangeLabels.last_30_days,
    startMs: endMs - (30 * 24 * 60 * 60 * 1000),
    endMs,
    grouping: "day",
  }
}

const alignToMinuteFloorSeconds = (ms: number): number => Math.floor(ms / 60000) * 60

const alignToMinuteCeilSeconds = (ms: number): number => {
  const ceilMs = Math.ceil(ms / 60000) * 60000
  return Math.floor(ceilMs / 1000)
}

const ensureNonEmptyMeterWindow = (startSeconds: number, endSeconds: number): { startSeconds: number, endSeconds: number } => {
  if (endSeconds > startSeconds) {
    return { startSeconds, endSeconds }
  }

  return {
    startSeconds,
    endSeconds: startSeconds + 60,
  }
}

const toIso = (seconds: number): string => new Date(seconds * 1000).toISOString()

const getInvoiceLinePriceId = (line: Stripe.InvoiceLineItem): string | null => {
  const lineWithPrice = line as Stripe.InvoiceLineItem & {
    price?: Stripe.Price | null
    pricing?: {
      price_details?: {
        price?: string | Stripe.Price | null
      }
    }
  }

  if (lineWithPrice.price?.id) {
    return lineWithPrice.price.id
  }

  const pricingPrice = lineWithPrice.pricing?.price_details?.price
  if (typeof pricingPrice === "string") {
    return pricingPrice
  }

  if (pricingPrice && typeof pricingPrice === "object" && "id" in pricingPrice) {
    return pricingPrice.id
  }

  return null
}

const getInvoiceLineUnitAmount = (line: Stripe.InvoiceLineItem): number | null => {
  const lineAny = line as Stripe.InvoiceLineItem & {
    price?: Stripe.Price | null
  }

  const unitAmountDecimal = lineAny.price?.unit_amount_decimal
  if (unitAmountDecimal !== undefined && unitAmountDecimal !== null) {
    const parsed = Number(unitAmountDecimal)
    return Number.isFinite(parsed) ? parsed : null
  }

  const quantity = Number(line.quantity || 0)
  if (quantity > 0) {
    return Number(line.amount || 0) / quantity
  }

  return null
}

const getPaymentIntentDescription = (paymentIntent: Stripe.PaymentIntent): string | null => {
  if (paymentIntent.description) {
    return paymentIntent.description
  }

  const stripeMetadataDescription = paymentIntent.metadata?.["description"]
  if (stripeMetadataDescription) {
    return stripeMetadataDescription
  }

  return null
}

const resolveUidByStripeCustomer = async (
  customerId: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): Promise<string | null> => {
  const normalizedCustomerId =
    typeof customerId === "string" ? customerId : customerId?.id || null

  if (!normalizedCustomerId) {
    return null
  }

  const userSnap = await db.collection("users")
    .where("stripeId", "==", normalizedCustomerId)
    .limit(1)
    .get()

  if (userSnap.empty) {
    return null
  }

  return userSnap.docs[0].id
}

// Record a paid conversion as an `analytics_events` fact plus its per-day counters.
//
// Idempotency: the fact doc id is derived from the payment id and written with
// `create()`, so a replayed webhook aborts the whole batch — counters included —
// instead of double-counting revenue. Same idea as the credits ledger.
//
// ponytail: the only non-analytics writer of `metrics_daily`, and it only ever adds
// revenue keys nothing else touches.
const recordPaidFact = async (
  uid: string,
  payment: {
    id: string
    amountMinor: number
    currency: string
    source: "subscription" | "payg" | "credits"
    plan?: string | null
    interval?: string | null
    reason?: string | null
  },
): Promise<void> => {
  const amountMinor = Math.round(Number(payment.amountMinor || 0))
  if (amountMinor <= 0) {
    return
  }

  const userSnap = await db.doc(`users/${uid}`).get()
  const user = userSnap.data() as (Users & { analytics?: { acquisition?: Guest["acquisition"] } }) | undefined
  let acquisition = user?.analytics?.acquisition

  // Signup merges the guest onto the user doc; fall back to the guest link for
  // accounts created before that merge shipped.
  if (!acquisition?.utmSource && !acquisition?.referrer && user?.loginMetricsId) {
    const guestSnap = await db.doc(`guests/${user.loginMetricsId}`).get()
    acquisition = (guestSnap.data() as Guest | undefined)?.acquisition
  }

  const fact = buildAnalyticsEvent({
    name: "paid",
    uid,
    isConversion: true,
    props: {
      amountMinor,
      currency: (payment.currency || "eur").toUpperCase(),
      plan: payment.plan || null,
      interval: payment.interval || null,
      source: payment.source,
      reason: payment.reason || null,
      channel: acquisition?.utmSource || acquisition?.referrer || "direct",
      utmMedium: acquisition?.utmMedium || null,
      utmCampaign: acquisition?.utmCampaign || null,
      landingPath: acquisition?.landingPath || null,
    },
  })

  const paidCounters = Object.fromEntries(
    toPaidCounterKeys(fact.props).map(([key, delta]) => [key, FieldValue.increment(delta)]),
  )
  const batch = db.batch()
  batch.create(db.collection(ANALYTICS_EVENTS).doc(`paid_${payment.id}`), fact)
  batch.set(db.doc(`metrics_daily/${fact.date}`), paidCounters, { merge: true })
  // Same counters into the hour bucket so the revenue panels also answer for
  // 30m/1h/24h. `set`+merge, not `create`, so the ALREADY_EXISTS abort below still
  // guarantees the *whole* batch is all-or-nothing.
  batch.set(db.doc(`metrics_hourly/${toEventHour(fact.ts)}`), paidCounters, { merge: true })

  try {
    await batch.commit()
  } catch (error) {
    // 6 = ALREADY_EXISTS: this payment was already recorded, counters untouched.
    if ((error as { code?: number }).code === 6) {
      return
    }
    throw error
  }
}

/* TODO: create a Stripe customer account for the user use most usable data */
type StripeCustomerInput = {
  uid: string
  providerData?: UserInfo[]
  email?: string | null
  displayName?: string | null
  phoneNumber?: string | null
}

/**
 * createCustomer
 * @param {*} firebaseUser
 */
export async function createCustomer(firebaseUser: StripeCustomerInput): Promise<Stripe.Response<Stripe.Customer>> {
  /**
   * callback
   * @param {*} s
   */
  const secret = stripeSecrets.find((s) => s.name === "STRIPE_SECRET_KEY")?.value()
  const stripe = getStripe(secret)
  const providerData = firebaseUser?.providerData as UserInfo[] | undefined

  const email = firebaseUser?.email || providerData?.[0]?.email || undefined
  const name = firebaseUser?.displayName || providerData?.[0]?.displayName || undefined
  const phone = firebaseUser?.phoneNumber || providerData?.[0]?.phoneNumber || undefined

  return stripe.customers.create({
    email,
    name,
    phone: phone || undefined,
    metadata: { firebaseUID: firebaseUser.uid },
  })
}


  const getSubscriptionCycleFields = (subscription: Stripe.Subscription): Partial<UserBilling> => {
    return {
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      cancelAt: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null,
      currentPeriodStart: subscription.current_period_start ? new Date(subscription.current_period_start * 1000).toISOString() : null,
      currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
    }
  }
/* Firebase Functions for stripe Workflow */

export const newStripeCustomer = onDocumentCreated(
  {
    document: "users/{userId}",
    database: dbName,
    secrets: stripeSecrets,
  },
  async (event) => {
    const userId = event.params.userId
    if (!userId) {
      return
    }

    const secret: string | undefined = stripeSecrets.find((secret) => secret.name === "STRIPE_SECRET_KEY")?.value()
    const stripe = getStripe(secret)
    const userPath = `users/${userId}`

    try {
      const [userDoc, fallbackAuthUserResult] = await Promise.all([
        db.doc(userPath).get(),
        adminAuth.getUser(userId).then((user) => ({ok: true as const, user})).catch((error) => ({ok: false as const, error})),
      ])

      const firebaseUser = userDoc.data() as Users
      if (!firebaseUser) {
        throw new Error(`User document not found for userId: ${userId}`)
      }

      let fallbackAuthUser: Awaited<ReturnType<typeof adminAuth.getUser>> | null = null
      if (fallbackAuthUserResult.ok) {
        fallbackAuthUser = fallbackAuthUserResult.user
      } else {
        console.warn(`Could not load auth profile for user ${userId}:`, fallbackAuthUserResult.error)
      }

      const userEmail =
        firebaseUser.email ||
        firebaseUser.providerData?.[0]?.email ||
        fallbackAuthUser?.email ||
        ""

      if (isBillingRestrictedUser(firebaseUser)) {
        await db.doc(userPath).set({
          stripeId: FieldValue.delete(),
          subscriptionId: null,
          plan: "free",
          status: "inactive",
          updated_At: new Date(),
        }, { merge: true })
        return
      }

      let stripeId = firebaseUser.stripeId || null
      if (!stripeId && userEmail) {
        const existingCustomers = await stripe.customers.list({
          email: userEmail,
          limit: 1,
        })

        if (existingCustomers.data.length > 0) {
          stripeId = existingCustomers.data[0].id
          console.log(`Using existing Stripe customer for email ${userEmail}`)
        }
      }

      if (!stripeId) {
        const customer = await createCustomer({
          uid: userId,
          providerData: firebaseUser.providerData,
          email: userEmail,
          displayName: firebaseUser.providerData?.[0]?.displayName || fallbackAuthUser?.displayName,
          phoneNumber: firebaseUser.providerData?.[0]?.phoneNumber || fallbackAuthUser?.phoneNumber,
        })
        stripeId = customer?.id
        console.log(`Created new Stripe customer for user ${userId}`)
      }

      await db.doc(userPath).set({ stripeId }, { merge: true })
    } catch (error) {
      console.error("Error in newStripeCustomer:", error)
      throw new HttpsError("internal", "Failed to create or link Stripe customer")
    }
  },
)


export const createPaymentIntent = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const secret: string | undefined = stripeSecrets.find((secret) => secret.name === "STRIPE_SECRET_KEY")?.value()
    const stripe = getStripe(secret)
    // Where the cart id is the cart id of last paymentIntent
    // plan chosen plan from cache memmory
    let clientSecret = ""
    let { amount, cartId } = req.data
    // The caller does not get to name the price. `currency` was the dangerous half: a
    // zero-decimal currency (JPY, KRW) redefines what an amount is worth, so the currency
    // comes from the catalog instead. The amount stays caller-chosen because a credit top-up
    // is deliberately pay-what-you-want, but it is now bounded by the same credits the
    // catalog actually sells.
    const currency = customCreditsCatalog.currency
    const amountCents = Number(amount)
    const minAmountCents = customCreditsCatalog.minimumCredits * customCreditsCatalog.unitAmount
    const maxAmountCents = customCreditsCatalog.maximumCredits * customCreditsCatalog.unitAmount
    try {
      const userId = req?.auth?.uid
      if (!userId) {
        throw new HttpsError("unauthenticated", "User must be authenticated")
      }

      if (!Number.isFinite(amountCents) || amountCents < minAmountCents || amountCents > maxAmountCents) {
        throw new HttpsError(
          "invalid-argument",
          `Amount must be between ${minAmountCents} and ${maxAmountCents} ${currency}`,
        )
      }

      console.log(`userId : ${userId}`)

      // Get the user from firestore
      const userDoc = await db.doc(`users/${userId}`).get()
      const user = userDoc.data() as Users | undefined
      assertBillingAllowed(user, getTokenRole(req))

      // Get the user's email
      const userEmail: string = user?.providerData?.length ?
        user?.providerData[0]?.email : ""


      // if cartId is not in session of the browser storage
      if (!cartId) {
        const listpayment = await stripe.paymentIntents.list({ customer: user?.stripeId })
        // Cancel only intents that are cancelable (requires_payment_method) to avoid
        // cancelling succeeded/processing intents from other browser tabs or sessions.
        const cancelableStatuses = new Set(["requires_payment_method", "requires_confirmation", "requires_action"])
        const cancelable = listpayment.data.filter((item) => cancelableStatuses.has(item.status))
        if (cancelable.length > 0) {
          await Promise.all(cancelable.map(async (item) => {
            await stripe.paymentIntents.cancel(item.id)
          }))
        }
        const paymentIntent = await stripe.paymentIntents.create({
          receipt_email: userEmail,
          currency,
          customer: user?.stripeId,
          payment_method_types: ["card"],
          amount: amountCents,
        })
        // FIXME: need to specified the cartId or create new cart if it doesn't exist
        const newCart = await db.collection(`users/${userId}/paymentcart`).add({
          paymentIntentId: paymentIntent.id,
          status: paymentIntent.status,
          created_At: paymentIntent.created,
          lastPaymentAttempt: new Date().getUTCDate(),
        })
        cartId = newCart.id
        clientSecret = paymentIntent.client_secret || "" // or is null
      } else {
        // retrieve the paymentIntent where already Created
        const cartData = await db.doc(`users/${userId}/paymentcart/${cartId}`).get()
        const cart = cartData.data()

        // get the latest used paymentIntentId
        if (cart?.paymentIntentId) {
          const incompleteIntent = await stripe.paymentIntents.retrieve(cart?.paymentIntentId)
          /* if (incompleteIntent.status === "requires_payment_method") {} */
          clientSecret = incompleteIntent.client_secret || "" // or is null
        }
      }

      return { clientSecret, cartId }
    } catch (error) {
      console.log(error)
      if (error instanceof HttpsError) {
        throw error
      }

      throw new HttpsError("internal", "cannot create a payment intent")
    }
  }
)

export const createSetupIntent = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const secret: string | undefined = stripeSecrets.find((secret) => secret.name === "STRIPE_SECRET_KEY")?.value()
    const stripe = getStripe(secret)
    const userId = req.auth?.uid
    if (!userId) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const { cartId } = req.data as { cartId?: string | null }
    const userRef = db.doc(`users/${userId}`)
    const userDoc = await userRef.get()
    const user = userDoc.data() as Users | undefined
    assertBillingAllowed(user, getTokenRole(req))

    const userEmail = user?.email || user?.providerData?.[0]?.email || ""
    let customerId = user?.stripeId
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        metadata: { firebaseUID: userId },
      })
      customerId = customer.id
      await userRef.set({ stripeId: customerId }, { merge: true })
    }

    const createNewSetupIntent = async () => {
      const setupIntent = await stripe.setupIntents.create({
        customer: customerId,
        usage: "off_session",
        automatic_payment_methods: {
          enabled: true,
        },
      })

      const createdCart = await db.collection(`users/${userId}/paymentcart`).add({
        setupIntentId: setupIntent.id,
        status: setupIntent.status,
        created_At: setupIntent.created,
        lastPaymentAttempt: new Date().toISOString(),
      })

      return {
        clientSecret: setupIntent.client_secret || "",
        cartId: createdCart.id,
      }
    }

    if (!cartId) {
      return createNewSetupIntent()
    }

    const cartRef = db.doc(`users/${userId}/paymentcart/${cartId}`)
    const cartSnap = await cartRef.get()
    const cart = cartSnap.data() as { setupIntentId?: string } | undefined

    if (!cart?.setupIntentId) {
      return createNewSetupIntent()
    }

    const setupIntent = await stripe.setupIntents.retrieve(cart.setupIntentId)
    if (setupIntent.status === "succeeded" || setupIntent.status === "canceled") {
      return createNewSetupIntent()
    }

    await cartRef.set({
      status: setupIntent.status,
      lastPaymentAttempt: new Date().toISOString(),
    }, { merge: true })

    return {
      clientSecret: setupIntent.client_secret || "",
      cartId,
    }
  },
)


export const startSubscription = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const secret: string | undefined = stripeSecrets.find((secret) => secret.name === "STRIPE_SECRET_KEY")?.value()
    const stripe = getStripe(secret)
    try {
      // 1. Get user data and validate
      const userId = req?.auth?.uid
      if (!userId) {
        throw new HttpsError("unauthenticated", "User must be authenticated")
      }

      const userDoc = await db.doc(`users/${userId}`).get()
      const user = userDoc.data() as Users | undefined
      assertBillingAllowed(user, getTokenRole(req))
      if (!user || !user.stripeId) {
        throw new HttpsError("not-found", "User or Stripe customer not found")
      }

      // 2. Extract and validate required data
      const { price, paymentMethod, currency } = req.data
      if (!price || !paymentMethod || !currency) {
        throw new HttpsError("invalid-argument", "Missing required payment information")
      }

      // 3. Check for existing subscription
      if (user.subscriptionId) {
        // Redirect to Stripe Customer Portal for plan changes — never silently update
        // an existing subscription without the user's explicit intent.
        throw new HttpsError(
          "failed-precondition",
          "User already has an active subscription. Use the Customer Portal to change plans.",
        )
      }

      // 4. Check for existing payment methods (PaymentMethods API)
      const paymentMethodsList = await stripe.paymentMethods.list({
        customer: user.stripeId,
        type: "card",
        limit: 100,
      })
      let paymentMethodExists = false
      for (const pm of paymentMethodsList.data) {
        if (pm.id === paymentMethod) {
          paymentMethodExists = true
          break
        }
      }
      // Attach payment method if not already attached
      if (!paymentMethodExists) {
        await stripe.paymentMethods.attach(paymentMethod, { customer: user.stripeId })
      }

      // 5. Set as default payment method for invoices
      await stripe.customers.update(user.stripeId, {
        invoice_settings: { default_payment_method: paymentMethod },
      })

      // 6. Create subscription with idempotency key and default payment method
      const sub = await stripe.subscriptions.create({
        customer: user.stripeId,
        items: [{ price }],
        default_payment_method: paymentMethod,
        currency,
      }, {
        idempotencyKey: `sub_${userId}_${price}`,
      })

      // 7. Update user document
      await db.doc(`users/${userId}`).update({
        status: sub.status,
        currentUsage: 0,
        subscriptionId: sub.id,
        itemId: sub.items.data[0].id,
      })

      return { message: "Subscription created successfully", subscriptionId: sub.id }
    } catch (error) {
      console.error("Error in startSubscription:", error)
      if (error instanceof HttpsError) {
        throw error
      }

      throw new HttpsError("internal", "Failed to start subscription")
    }
  }
)

export const getBillingCatalog = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async () => {
    return {
      plans: billingPlanCatalog,
      creditPacks: creditPackCatalog,
      customCredits: customCreditsCatalog,
      periods: ["payAsYouGo", "monthly", "quarterly", "annually"] as BillingInterval[],
      currency: "eur",
    }
  }
)

export const validateStripeCatalog = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const userId = req.auth?.uid
    if (!userId) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const authUser = await adminAuth.getUser(userId)
    const userEmail = (authUser.email || "").toLowerCase()
    const allowedAdmins = new Set(env.ADMIN_EMAILS.map((email) => email.toLowerCase()))
    if (!userEmail || !allowedAdmins.has(userEmail)) {
      throw new HttpsError("permission-denied", "Only bootstrap admins can validate Stripe catalog")
    }

    const secret: string | undefined = stripeSecrets.find((secret) => secret.name === "STRIPE_SECRET_KEY")?.value()
    const stripe = getStripe(secret)
    const issues: Array<{
      id: string
      type: "plan" | "credit"
      ref: string
      severity: "error" | "warning"
      message: string
    }> = []

    const expectedPlanMonths: Record<Exclude<BillingInterval, "payAsYouGo">, number> = {
      monthly: 1,
      quarterly: 3,
      annually: 12,
    }

    const priceRefs = [
      ...billingPlanCatalog.flatMap((plan) =>
        (Object.keys(plan.prices) as BillingInterval[])
          .map((interval) => ({
            id: plan.prices[interval].stripePriceId,
            lookupKey: lookupKeyForPlan(plan.id, interval),
            type: "plan" as const,
            ref: `${plan.id}:${interval}`,
            expectedAmount: plan.prices[interval].amount,
            expectedCurrency: plan.prices[interval].currency,
            expectedRecurring: interval !== "payAsYouGo",
            expectedMonths: interval === "payAsYouGo" ? null : expectedPlanMonths[interval],
          }))
          .filter((item) => Boolean(item.id)),
      ),
      ...creditPackCatalog
        .map((pack) => ({
          id: pack.stripePriceId,
          lookupKey: lookupKeyForCredits(pack.credits),
          type: "credit" as const,
          ref: pack.id,
          expectedAmount: pack.amount,
          expectedCurrency: pack.currency,
          expectedRecurring: false,
          expectedMonths: null as number | null,
        }))
        .filter((item) => Boolean(item.id)),
    ] as Array<{
      id?: string
      lookupKey: string
      type: "plan" | "credit"
      ref: string
      expectedAmount: number
      expectedCurrency: string
      expectedRecurring: boolean
      expectedMonths: number | null
    }>

    const products = new Set<string>()
    let validCount = 0

    await Promise.all(priceRefs.map(async (priceRef) => {
      if (!priceRef.id) {
        return
      }

      try {
        // Same resolution order as checkout: lookup_key first, id as the fallback. Validating
        // only the hardcoded ids reported every price as broken on a deployment that serves a
        // catalog built from lookup_keys, and said nothing at all when the key was missing.
        const byLookupKey = await stripe.prices.list({
          lookup_keys: [priceRef.lookupKey],
          limit: 1,
          expand: ["data.product"],
        })

        let price = byLookupKey.data[0]

        if (!price) {
          price = await stripe.prices.retrieve(priceRef.id, { expand: ["product"] })
          issues.push({
            id: price.id,
            type: priceRef.type,
            ref: priceRef.ref,
            severity: "warning",
            message: `Resolved by price id fallback; lookup_key ${priceRef.lookupKey} is not in this account`,
          })
        }

        // Past this point the issues name the price that actually answered, not the
        // configured fallback id, so the report points at a real object in this account.
        const priceId = price.id

        if (price.currency !== priceRef.expectedCurrency) {
          issues.push({
            id: priceId,
            type: priceRef.type,
            ref: priceRef.ref,
            severity: "error",
            message: `Currency mismatch: expected ${priceRef.expectedCurrency}, got ${price.currency}`,
          })
        }

        if ((price.unit_amount ?? null) !== priceRef.expectedAmount) {
          issues.push({
            id: priceId,
            type: priceRef.type,
            ref: priceRef.ref,
            severity: "error",
            message: `Amount mismatch: expected ${priceRef.expectedAmount}, got ${price.unit_amount}`,
          })
        }

        if (!price.active) {
          issues.push({
            id: priceId,
            type: priceRef.type,
            ref: priceRef.ref,
            severity: "warning",
            message: "Price exists but is inactive",
          })
        }

        const recurring = price.recurring
        if (priceRef.expectedRecurring && !recurring) {
          issues.push({
            id: priceId,
            type: priceRef.type,
            ref: priceRef.ref,
            severity: "error",
            message: "Expected recurring price but got one-time price",
          })
        }

        if (!priceRef.expectedRecurring && recurring) {
          issues.push({
            id: priceId,
            type: priceRef.type,
            ref: priceRef.ref,
            severity: "error",
            message: "Expected one-time price but got recurring price",
          })
        }

        if (priceRef.expectedRecurring && recurring && priceRef.expectedMonths) {
          const actualMonths = getIntervalMonths(recurring.interval, recurring.interval_count)
          if (actualMonths !== priceRef.expectedMonths) {
            issues.push({
              id: priceId,
              type: priceRef.type,
              ref: priceRef.ref,
              severity: "warning",
              message: `Recurring interval mismatch: expected ${priceRef.expectedMonths} month(s), got ${actualMonths}`,
            })
          }
        }

        const product = price.product
        if (typeof product === "string") {
          products.add(product)
        } else {
          products.add(product.id)
          if ("active" in product && !product.active) {
            issues.push({
              id: priceId,
              type: priceRef.type,
              ref: priceRef.ref,
              severity: "warning",
              message: `Linked product ${product.id} is inactive`,
            })
          }
        }

        validCount += 1
      } catch (error) {
        issues.push({
          id: priceRef.id,
          type: priceRef.type,
          ref: priceRef.ref,
          severity: "error",
          message: `Price lookup failed: ${error instanceof Error ? error.message : "unknown error"}`,
        })
      }
    }))

    // Which account answered matters: the hardcoded fallback ids belong to the sandbox
    // account, so a live run reporting them as missing is expected, not a config error.
    // Derive the mode from the key prefix; the key itself is never returned or logged.
    let keyMode = "unknown"
    if (secret?.includes("_live_")) {
      keyMode = "live"
    } else if (secret?.includes("_test_")) {
      keyMode = "test"
    }

    let accountId: string | null = null
    try {
      const account = await stripe.accounts.retrieve()
      accountId = account.id
    } catch {
      // Hint only - never fail validation because the account could not be read.
    }

    return {
      mode: keyMode,
      accountHint: `${keyMode} key on account: ${accountId ?? "unknown"}`,
      checkedPrices: priceRefs.length,
      resolvedPrices: validCount,
      distinctProducts: products.size,
      hasErrors: issues.some((issue) => issue.severity === "error"),
      issues,
    }
  },
)

export const getMyEntitlements = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const userId = req.auth?.uid
    if (!userId) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    // Fire-and-forget entitlement check metric counter.
    const metricDayKey = new Date().toISOString().slice(0, 10)
    db.doc(`billing_entitlement_metrics/${metricDayKey}`).set({
      totalCalls: FieldValue.increment(1),
      lastCallAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => undefined)

    const billingRef = db.doc(`users/${userId}/billing/current`)
    const userRef = db.doc(`users/${userId}`)
    // FIX #3: single user-doc read; billing cached in user.billing field after first write
    const userSnap = await userRef.get()

    const user = userSnap.data() as Users & { billing?: UserBilling } | undefined
    const tokenRole = getTokenRole(req)

    // Prefer billing snapshot embedded in user doc; fall back to subcollection on first call
    let existingBilling = user?.billing as UserBilling | undefined
    let billingDocExists = existingBilling !== undefined
    if (!existingBilling) {
      const billingSnap = await billingRef.get()
      billingDocExists = billingSnap.exists
      existingBilling = billingSnap.exists ? billingSnap.data() as UserBilling : undefined
    }

    if (isBillingRestrictedUser(user, tokenRole)) {
      const restrictedBilling: Partial<UserBilling> = {
        ...getDefaultBillingForPlan("free"),
        plan: "free",
        status: "inactive",
        subscriptionId: null,
        planInterval: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        trialUsedAt: existingBilling?.trialUsedAt || null,
        trialStartedAt: existingBilling?.trialStartedAt || null,
        trialEndsAt: existingBilling?.trialEndsAt || null,
        updatedAt: FieldValue.serverTimestamp(),
      }

      await Promise.all([
        billingRef.set(restrictedBilling, { merge: true }),
        userRef.set({
          billing: restrictedBilling,
          plan: "free",
          status: "inactive",
          subscriptionId: null,
          stripeId: FieldValue.delete(),
          updated_At: new Date(),
        }, { merge: true }),
      ])

      return { billing: restrictedBilling, userId }
    }

    if (!billingDocExists) {
      const initialPlan = mapPlanIdToTier(user?.plan || "free")
      const billing = getDefaultBillingForPlan(initialPlan)
      await Promise.all([
        billingRef.set(billing, { merge: true }),
        syncBillingToUserDoc(userRef, billing),
      ])
      return { billing, userId }
    }

    if (hasTrialExpired(existingBilling)) {
      const nextBilling = buildFreePlanFromExpiredTrial(existingBilling)
      await Promise.all([
        billingRef.set(nextBilling, { merge: true }),
        userRef.set({
          billing: nextBilling,
          plan: "free",
          status: "inactive",
          subscriptionId: null,
          updated_At: new Date(),
        }, { merge: true }),
      ])
      return { billing: nextBilling, userId }
    }

    const shouldInferPaygPlan =
      (existingBilling?.plan || "free") === "free" &&
      !existingBilling?.subscriptionId &&
      Boolean(user?.stripeId)

    if (shouldInferPaygPlan && user?.stripeId) {
      try {
        const secret: string | undefined = stripeSecrets.find((entry) => entry.name === "STRIPE_SECRET_KEY")?.value()
        const stripe = getStripe(secret)

        const subscriptions = await stripe.subscriptions.list({
          customer: user.stripeId,
          status: "all",
          limit: 10,
        })

        const latestActiveRecurring = subscriptions.data
          .filter((subscription) => ["active", "trialing", "past_due", "unpaid"].includes(subscription.status))
          .sort((a, b) => b.created - a.created)[0]

        const recurringPrice = latestActiveRecurring?.items?.data?.[0]?.price
        const recurringMatch = inferRecurringPlanFromPriceId(recurringPrice?.id, recurringPrice?.lookup_key)

        if (latestActiveRecurring && recurringMatch) {
          const effectivePlan: BillingPlanTier = latestActiveRecurring.status === "trialing" ? "trial" : recurringMatch.plan
          const inferredBilling = {
            plan: effectivePlan,
            planInterval: recurringMatch.interval,
            status: latestActiveRecurring.status,
            subscriptionId: latestActiveRecurring.id,
            features: getFeaturesFromPlan(effectivePlan),
            ...getSubscriptionCycleFields(latestActiveRecurring),
            ...(latestActiveRecurring.status === "trialing" ? {
              trialPlanTarget: recurringMatch.plan,
              trialStartedAt: new Date(latestActiveRecurring.current_period_start * 1000).toISOString(),
              trialEndsAt: latestActiveRecurring.trial_end ? new Date(latestActiveRecurring.trial_end * 1000).toISOString() : null,
              trialUsedAt: new Date().toISOString(),
              trialCreditCapEur: TRIAL_DEFAULT_CREDIT_CAP_EUR,
            } : {
              trialPlanTarget: null,
              trialStartedAt: null,
              trialEndsAt: null,
            }),
            updatedAt: FieldValue.serverTimestamp(),
          }

          await Promise.all([
            billingRef.set(inferredBilling, { merge: true }),
            userRef.set({
              billing: inferredBilling,
              plan: effectivePlan,
              status: latestActiveRecurring.status,
              subscriptionId: latestActiveRecurring.id,
              updated_At: new Date(),
            }, { merge: true }),
          ])

          return { billing: inferredBilling, userId }
        }

        const paymentIntents = await stripe.paymentIntents.list({
          customer: user.stripeId,
          limit: 20,
        })

        const latestSucceeded = paymentIntents.data
          .filter((intent) => intent.status === "succeeded")
          .sort((a, b) => b.created - a.created)[0]

        const inferredPlan = latestSucceeded ? inferPayAsYouGoPlanFromPayment({
          amount: latestSucceeded.amount,
          currency: latestSucceeded.currency,
        }) : null

        if (inferredPlan) {
          const paygBilling = {
            ...getDefaultBillingForPlan(inferredPlan),
            plan: inferredPlan,
            planInterval: "payAsYouGo" as BillingInterval,
            status: "active",
            updatedAt: FieldValue.serverTimestamp(),
          }

          await Promise.all([
            billingRef.set(paygBilling, { merge: true }),
            userRef.set({
              billing: paygBilling,
              plan: inferredPlan,
              status: "active",
              updated_At: new Date(),
            }, { merge: true }),
          ])

          return { billing: paygBilling, userId }
        }
      } catch (error) {
        console.warn("Entitlement inference from successful pay-as-you-go payments failed:", error)
      }
    }

    return { billing: existingBilling, userId }
  }
)

export const startTrial = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const userId = req.auth?.uid
    if (!userId) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const userRef = db.doc(`users/${userId}`)
    const billingRef = db.doc(`users/${userId}/billing/current`)
    // FIX #3: single read — billing cached in user.billing after first write
    const userSnap = await userRef.get()
    const user = userSnap.data() as Users & { billing?: UserBilling } | undefined

    assertBillingAllowed(user, getTokenRole(req))

    const billing = user?.billing as UserBilling | undefined
    const alreadyUsedTrial = Boolean(billing?.trialUsedAt)
    if (alreadyUsedTrial) {
      throw new HttpsError("failed-precondition", "Trial can only be used once per account")
    }

    if (billing?.plan && billing.plan !== "free" && billing.plan !== "trial") {
      throw new HttpsError("failed-precondition", "Trial can only be started from the free plan")
    }

    const now = new Date()
    const endsAt = new Date(now.getTime() + TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000)

    const trialBilling: Partial<UserBilling> = {
      ...getDefaultBillingForPlan("trial"),
      plan: "trial",
      status: "active",
      subscriptionId: null,
      planInterval: null,
      trialPlanTarget: "pro",
      trialStartedAt: now.toISOString(),
      trialEndsAt: endsAt.toISOString(),
      trialUsedAt: now.toISOString(),
      trialCreditCapEur: TRIAL_DEFAULT_CREDIT_CAP_EUR,
      updatedAt: FieldValue.serverTimestamp(),
    }

    await Promise.all([
      billingRef.set(trialBilling, { merge: true }),
      userRef.set({
        billing: trialBilling,
        plan: "trial",
        status: "active",
        subscriptionId: null,
        updated_At: now,
      }, { merge: true }),
    ])

    return {
      billing: trialBilling,
      userId,
      trialStartedAt: trialBilling.trialStartedAt,
      trialEndsAt: trialBilling.trialEndsAt,
    }
  },
)

export const getBillingUsage = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const userId = req.auth?.uid
    if (!userId) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const data = (req.data || {}) as {
      range?: BillingUsageRangeKey
    }

    const rangeKey = asBillingUsageRangeKey(data.range)
    const window = resolveBillingUsageWindow(rangeKey)
    const createdRange: Stripe.RangeQueryParam = {
      gte: Math.floor(window.startMs / 1000),
      lte: Math.floor(window.endMs / 1000),
    }

    const userSnap = await db.doc(`users/${userId}`).get()
    const user = userSnap.data() as Users | undefined
    assertBillingAllowed(user, getTokenRole(req))
    const stripeCustomerId = user?.stripeId || null

    const emptyResponse = {
      range: {
        key: window.key,
        label: window.label,
        start: new Date(window.startMs).toISOString(),
        end: new Date(window.endMs).toISOString(),
        grouping: window.grouping,
      },
      summary: {
        currency: "eur",
        totalInvoiced: 0,
        totalPaid: 0,
        totalMeteredUnits: 0,
      },
      meteredUsage: {
        meters: [] as Array<{
          meterId: string
          displayName: string
          eventName: string
          aggregatedValue: number
          timeline: Array<{
            start: string
            end: string
            value: number
          }>
        }>,
      },
      invoices: [] as Array<{
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
      }>,
      payments: [] as Array<{
        id: string
        status: string
        amount: number
        currency: string
        createdAt: string
        description: string | null
      }>,
      breakdown: [] as Array<{
        id: string
        date: string
        source: "invoice_line" | "payment" | "meter"
        category: string
        description: string
        quantity: number | null
        unitAmount: number | null
        total: number
        currency: string
        referenceId: string
      }>,
    }

    if (!stripeCustomerId) {
      return emptyResponse
    }

    const secret: string | undefined = stripeSecrets.find((entry) => entry.name === "STRIPE_SECRET_KEY")?.value()
    const stripe = getStripe(secret)

    const [invoiceList, paymentIntentList, meterList] = await Promise.all([
      stripe.invoices.list({
        customer: stripeCustomerId,
        created: createdRange,
        limit: 100,
      }),
      stripe.paymentIntents.list({
        customer: stripeCustomerId,
        created: createdRange,
        limit: 100,
      }),
      stripe.billing.meters.list({
        status: "active",
        limit: 25,
      }).catch(() => ({ data: [] as Stripe.Billing.Meter[] } as { data: Stripe.Billing.Meter[] })),
    ])

    const invoiceRows = invoiceList.data.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      total: Number(invoice.total || 0),
      amountPaid: Number(invoice.amount_paid || 0),
      currency: (invoice.currency || "eur").toLowerCase(),
      periodStart: invoice.period_start ? toIso(invoice.period_start) : null,
      periodEnd: invoice.period_end ? toIso(invoice.period_end) : null,
      createdAt: toIso(invoice.created),
      hostedInvoiceUrl: invoice.hosted_invoice_url || null,
    }))

    const paymentRows = paymentIntentList.data.map((paymentIntent) => ({
      id: paymentIntent.id,
      status: paymentIntent.status,
      amount: Number(paymentIntent.amount || 0),
      currency: (paymentIntent.currency || "eur").toLowerCase(),
      createdAt: toIso(paymentIntent.created),
      description: getPaymentIntentDescription(paymentIntent),
    }))

    const meterWindowStart = alignToMinuteFloorSeconds(window.startMs)
    const meterWindowEnd = alignToMinuteCeilSeconds(window.endMs)
    const safeMeterWindow = ensureNonEmptyMeterWindow(meterWindowStart, meterWindowEnd)

    const meterSummaryRows = await Promise.all(meterList.data.map(async (meter) => {
      try {
        const summaries = await stripe.billing.meters.listEventSummaries(meter.id, {
          customer: stripeCustomerId,
          start_time: safeMeterWindow.startSeconds,
          end_time: safeMeterWindow.endSeconds,
          value_grouping_window: window.grouping,
          limit: 100,
        })

        const timeline = summaries.data.map((summary) => ({
          start: toIso(summary.start_time),
          end: toIso(summary.end_time),
          value: Number(summary.aggregated_value || 0),
        }))

        const aggregatedValue = timeline.reduce((acc, item) => acc + item.value, 0)

        return {
          meterId: meter.id,
          displayName: meter.display_name,
          eventName: meter.event_name,
          aggregatedValue,
          timeline,
        }
      } catch {
        return {
          meterId: meter.id,
          displayName: meter.display_name,
          eventName: meter.event_name,
          aggregatedValue: 0,
          timeline: [],
        }
      }
    }))

    const breakdownFromInvoices = invoiceList.data.flatMap((invoice) => {
      const lines = invoice.lines?.data || []

      return lines.map((line, lineIndex) => {
        const lineWithPrice = line as Stripe.InvoiceLineItem & { price?: Stripe.Price | null }
        const recurringType = lineWithPrice.price?.recurring ? "license" : "one_time"
        const quantity = line.quantity ?? null
        const unitAmount = getInvoiceLineUnitAmount(line)
        const amount = Number(line.amount || 0)
        const linePriceId = getInvoiceLinePriceId(line)

        return {
          id: `${invoice.id}_line_${lineIndex}`,
          date: toIso(line.period?.end || invoice.created),
          source: "invoice_line" as const,
          category: recurringType,
          description: line.description || linePriceId || "Invoice line",
          quantity: quantity === null ? null : Number(quantity),
          unitAmount,
          total: amount,
          currency: (invoice.currency || "eur").toLowerCase(),
          referenceId: invoice.id,
        }
      })
    })

    const breakdownFromPayments = paymentRows.map((payment) => ({
      id: `${payment.id}_payment`,
      date: payment.createdAt,
      source: "payment" as const,
      category: "payment",
      description: payment.description || "Payment received",
      quantity: 1,
      unitAmount: payment.amount,
      total: payment.amount,
      currency: payment.currency,
      referenceId: payment.id,
    }))

    const breakdownFromMeters = meterSummaryRows.flatMap((meter) =>
      meter.timeline.map((item, timelineIndex) => ({
        id: `${meter.meterId}_meter_${timelineIndex}`,
        date: item.end,
        source: "meter" as const,
        category: "metered_usage",
        description: `${meter.displayName} (${meter.eventName})`,
        quantity: item.value,
        unitAmount: null,
        total: item.value,
        currency: "units",
        referenceId: meter.meterId,
      })))

    const breakdown = [
      ...breakdownFromInvoices,
      ...breakdownFromPayments,
      ...breakdownFromMeters,
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

    const totalInvoiced = invoiceRows.reduce((acc, row) => acc + row.total, 0)
    const totalPaid = invoiceRows.reduce((acc, row) => acc + row.amountPaid, 0)
    const totalMeteredUnits = meterSummaryRows.reduce((acc, row) => acc + row.aggregatedValue, 0)

    return {
      range: {
        key: window.key,
        label: window.label,
        start: new Date(window.startMs).toISOString(),
        end: new Date(window.endMs).toISOString(),
        grouping: window.grouping,
      },
      summary: {
        currency: invoiceRows[0]?.currency || "eur",
        totalInvoiced,
        totalPaid,
        totalMeteredUnits,
      },
      meteredUsage: {
        meters: meterSummaryRows,
      },
      invoices: invoiceRows,
      payments: paymentRows,
      breakdown,
    }
  },
)

export const createCheckoutSession = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const secret: string | undefined = stripeSecrets.find((secret) => secret.name === "STRIPE_SECRET_KEY")?.value()
    const stripe = getStripe(secret)
    const userId = req.auth?.uid
    if (!userId) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const {
      planId,
      interval = "monthly",
      successUrl,
      cancelUrl,
      quantity = 1,
      customCredits,
      checkoutRequestId,
    } = req.data as {
      planId: string
      interval?: BillingInterval
      successUrl: string
      cancelUrl: string
      quantity?: number
      customCredits?: number
      checkoutRequestId?: string
    }

    if (!planId || !successUrl || !cancelUrl) {
      throw new HttpsError("invalid-argument", "Missing required checkout arguments")
    }

    const normalizedCheckoutRequestId = String(checkoutRequestId || "").trim()
    if (!normalizedCheckoutRequestId) {
      throw new HttpsError("invalid-argument", "checkoutRequestId is required for idempotent checkout")
    }

    assertAllowedReturnUrl(successUrl, "successUrl")
    assertAllowedReturnUrl(cancelUrl, "cancelUrl")

    if (!isBillingInterval(interval)) {
      throw new HttpsError("invalid-argument", "Invalid billing interval")
    }

    const userSnap = await db.doc(`users/${userId}`).get()
    const user = userSnap.data() as Users & { billing?: UserBilling } | undefined
    // FIX #3: billing embedded in user doc — no subcollection read needed
    const billing = user?.billing as UserBilling | undefined
  assertBillingAllowed(user, getTokenRole(req))
    const userEmail = user?.email || user?.providerData?.[0]?.email || ""

    let customerId = user?.stripeId
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        metadata: { firebaseUID: userId },
      })
      customerId = customer.id
      await db.doc(`users/${userId}`).set({ stripeId: customerId }, { merge: true })
    }

    const selectedPlan = billingPlanCatalog.find((item) => item.id === planId)
    const selectedPack = creditPackCatalog.find((item) => item.id === planId)
    const isCustomCredits = planId === "custom_credits"

    if (!selectedPlan && !selectedPack && !isCustomCredits) {
      throw new HttpsError("not-found", "Unknown plan or credit pack")
    }

    const isCreditPack = Boolean(selectedPack)
    const isPayAsYouGoPlan = Boolean(selectedPlan) && interval === "payAsYouGo"
    const normalizedCustomCredits = isCustomCredits ? Math.floor(Number(customCredits || 0)) : 0

    if (isCreditPack || isCustomCredits) {
      assertCreditModeAllowed(billing)
    }

    if (isCustomCredits) {
      if (!customCreditsCatalog.enabled) {
        throw new HttpsError("failed-precondition", "Custom credits are currently disabled")
      }

      if (!Number.isFinite(normalizedCustomCredits) || normalizedCustomCredits < customCreditsCatalog.minimumCredits || normalizedCustomCredits > customCreditsCatalog.maximumCredits) {
        throw new HttpsError(
          "invalid-argument",
          `Custom credits must be between ${customCreditsCatalog.minimumCredits} and ${customCreditsCatalog.maximumCredits}`,
        )
      }
    }

    const selectedPlanPrice = selectedPlan ? selectedPlan.prices[interval] : undefined
    const catalogPriceId = isCreditPack ? selectedPack?.stripePriceId : selectedPlanPrice?.stripePriceId
    // Resolve by lookup_key first so one deployment works in test and live, falling back
    // to the catalog id, which is what this did before the resolver existed.
    let priceLookupKey: string | undefined
    if (isCreditPack && selectedPack) {
      priceLookupKey = lookupKeyForCredits(selectedPack.credits)
    } else if (selectedPlan) {
      priceLookupKey = lookupKeyForPlan(selectedPlan.id, interval)
    }

    let stripePriceId = catalogPriceId
    if (priceLookupKey) {
      stripePriceId = await resolvePriceId(stripe, priceLookupKey, catalogPriceId)
    }

    if (!isCustomCredits && !stripePriceId) {
      throw new HttpsError("failed-precondition", "Stripe price id is missing for selected option")
    }

    const checkoutMode: Stripe.Checkout.SessionCreateParams.Mode = (isCreditPack || isPayAsYouGoPlan || isCustomCredits) ? "payment" : "subscription"

    let trialPeriodDays: number | undefined
    if (checkoutMode === "subscription" && selectedPlan?.id === "pro") {
      const alreadyUsedTrial = Boolean(
        billing?.trialUsedAt ||
        billing?.plan === "trial" ||
        billing?.trialPlanTarget
      )

      if (!alreadyUsedTrial) {
        trialPeriodDays = TRIAL_PERIOD_DAYS
      }
    }

    const checkoutMetadata = {
      uid: userId,
      planId,
      interval,
      checkoutType: isCustomCredits ? "custom_credits" : isCreditPack ? "credits" : isPayAsYouGoPlan ? "plan_payg" : "plan",
      customCredits: isCustomCredits ? String(normalizedCustomCredits) : "0",
      trialApplied: trialPeriodDays ? "true" : "false",
    }

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = isCustomCredits ? [{
      price_data: {
        currency: customCreditsCatalog.currency,
        unit_amount: customCreditsCatalog.unitAmount,
        product_data: {
          name: "DeepScrape Custom Credits",
          description: `${normalizedCustomCredits} custom credits for usage-based access on the free plan`,
        },
      },
      quantity: normalizedCustomCredits,
    }] : [{
      price: stripePriceId,
      quantity: isCreditPack ? Math.max(1, quantity) : 1,
    }]

    // What currency the customer is shown. Stripe Tax never reads this - it uses the
    // customer's address - so a mismatch is harmless; this only decides the number on the
    // button. A returning payer's saved address is the stronger signal (it is the address the
    // tax will use), the request's own country is the fallback. There is no map to maintain:
    // only "us" has its own price book today, everything else stays in the integration
    // currency. Add a branch when a second currency earns its place, not before.
    let currency: string | undefined
    let country: string | null = null
    if (user?.stripeId) {
      try {
        const savedCustomer = await stripe.customers.retrieve(user.stripeId)
        if (!savedCustomer.deleted) {
          country = savedCustomer.address?.country || null
        }
      } catch {
        // Never block a checkout on a lookup that only picks a currency.
      }
    }
    if (!country) {
      const geo = await lookupGeoByIp(req.rawRequest?.ip, { firebaseUid: userId })
      country = geo?.countryShort || null
    }
    if (country?.toUpperCase() === "US") {
      currency = "usd"
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: checkoutMode,
      // undefined leaves the choice to Stripe (integration currency, or local presentment
      // once that is switched on). Setting it means "use my currency_options amount".
      currency,
      line_items: lineItems,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: checkoutMetadata,
      // The catalog's prices are tax_behavior "inclusive", so the tax is carved back out of the
      // displayed amount rather than added on top - the number on the pricing page is the number
      // charged, and registering for VAT later changes what you keep, not what the customer pays.
      // Stripe still needs the customer's location to calculate it, and `customer_update.address`
      // is what lets the address collected at checkout be used for a customer we already created -
      // remove it and every session with an existing customer fails to create.
      // billing_address_collection stays at its "auto" default: Checkout collects exactly the
      // fields the tax calculation needs.
      automatic_tax: { enabled: true },
      customer_update: { address: "auto", name: "auto" },
      // Lets a business enter a VAT ID, which is what turns an EU B2B sale into a reverse
      // charge instead of a VAT charge. Drop this line if you only want consumer sales taxed.
      tax_id_collection: { enabled: true },
      payment_intent_data: checkoutMode === "payment" ? {
        metadata: checkoutMetadata,
      } : undefined,
      subscription_data: checkoutMode === "subscription" ? {
        metadata: checkoutMetadata,
        trial_period_days: trialPeriodDays,
        trial_settings: trialPeriodDays ? {
          end_behavior: {
            missing_payment_method: "cancel",
          },
        } : undefined,
      } : undefined,
      client_reference_id: userId,
      allow_promotion_codes: true,
    }, {
      idempotencyKey: `checkout_${userId}_${planId}_${interval}_${isCustomCredits ? normalizedCustomCredits : Math.max(1, quantity)}_${normalizedCheckoutRequestId}`,
    })

    return {
      url: session.url,
      sessionId: session.id,
    }
  }
)

export const createBillingPortalSession = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const secret: string | undefined = stripeSecrets.find((secret) => secret.name === "STRIPE_SECRET_KEY")?.value()
    const stripe = getStripe(secret)
    const userId = req.auth?.uid
    if (!userId) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const { returnUrl } = req.data as { returnUrl?: string }
    if (!returnUrl) {
      throw new HttpsError("invalid-argument", "Missing returnUrl")
    }
    assertAllowedReturnUrl(returnUrl, "returnUrl")

    const userSnap = await db.doc(`users/${userId}`).get()
    const user = userSnap.data() as Users | undefined
    assertBillingAllowed(user, getTokenRole(req))
    if (!user?.stripeId) {
      throw new HttpsError("failed-precondition", "Stripe customer not found")
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripeId,
      return_url: returnUrl,
    })

    return { url: portal.url }
  }
)

export const resumeSubscriptionCancellation = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const secret: string | undefined = stripeSecrets.find((entry) => entry.name === "STRIPE_SECRET_KEY")?.value()
    const stripe = getStripe(secret)
    const userId = req.auth?.uid

    if (!userId) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const userRef = db.doc(`users/${userId}`)
    const billingRef = db.doc(`users/${userId}/billing/current`)
    // FIX #3: single read — billing cached in user.billing after first write
    const userSnap = await userRef.get()

    const user = userSnap.data() as Users & { billing?: UserBilling } | undefined
    assertBillingAllowed(user, getTokenRole(req))

    const billing = user?.billing as UserBilling | undefined
    const subscriptionId = billing?.subscriptionId || user?.subscriptionId || null
    if (!subscriptionId) {
      throw new HttpsError("failed-precondition", "No active subscription found")
    }

    const updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    })

    const recurringPrice = updatedSubscription.items.data[0]?.price
    const recurringMatch = inferRecurringPlanFromPriceId(recurringPrice?.id, recurringPrice?.lookup_key)
    const currentPlan = billing?.plan || mapPlanIdToTier(user?.plan || "free")
    const effectivePlan: BillingPlanTier = updatedSubscription.status === "trialing" ?
     "trial" : (recurringMatch?.plan || currentPlan)

    const updatedBilling = {
      ...getDefaultBillingForPlan(effectivePlan),
      plan: effectivePlan,
      planInterval: recurringMatch?.interval || billing?.planInterval || null,
      status: updatedSubscription.status,
      subscriptionId: updatedSubscription.id,
      features: getFeaturesFromPlan(effectivePlan),
      ...getSubscriptionCycleFields(updatedSubscription),
      ...(updatedSubscription.status === "trialing" ? {
        trialPlanTarget: recurringMatch?.plan || billing?.trialPlanTarget || "pro",
        trialStartedAt: billing?.trialStartedAt || new Date(updatedSubscription.current_period_start * 1000).toISOString(),
        trialEndsAt: updatedSubscription.trial_end ? new Date(updatedSubscription.trial_end * 1000).toISOString() : null,
        trialUsedAt: billing?.trialUsedAt || new Date().toISOString(),
        trialCreditCapEur: billing?.trialCreditCapEur || TRIAL_DEFAULT_CREDIT_CAP_EUR,
      } : {
        trialPlanTarget: null,
        trialStartedAt: null,
        trialEndsAt: null,
      }),
      updatedAt: FieldValue.serverTimestamp(),
    }

    await Promise.all([
      billingRef.set(updatedBilling, { merge: true }),
      userRef.set({
        billing: updatedBilling,
        plan: effectivePlan,
        status: updatedSubscription.status,
        subscriptionId: updatedSubscription.id,
        updated_At: new Date(),
      }, { merge: true }),
    ])

    return {
      billing: updatedBilling,
      subscriptionId: updatedSubscription.id,
      cancelAtPeriodEnd: updatedSubscription.cancel_at_period_end,
    }
  }
)

export const verifyCheckoutSession = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const secret: string | undefined = stripeSecrets.find((entry) => entry.name === "STRIPE_SECRET_KEY")?.value()
    const stripe = getStripe(secret)
    const userId = req.auth?.uid

    if (!userId) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const userSnap = await db.doc(`users/${userId}`).get()
    const user = userSnap.data() as Users | undefined
    assertBillingAllowed(user, getTokenRole(req))

    const { sessionId } = req.data as { sessionId?: string }
    if (!sessionId) {
      throw new HttpsError("invalid-argument", "Missing sessionId")
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId)

    const sessionOwner = session.client_reference_id || session.metadata?.uid
    if (!sessionOwner || sessionOwner !== userId) {
      throw new HttpsError("permission-denied", "Session does not belong to current user")
    }

    const isCompleted = session.status === "complete"
    const isPaidOneTime = session.mode === "payment" && session.payment_status === "paid"
    const isValidSubscription = session.mode === "subscription" && (
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required"
    )

    return {
      valid: isCompleted && (isPaidOneTime || isValidSubscription),
      mode: session.mode,
      paymentStatus: session.payment_status,
      status: session.status,
      sessionId: session.id,
    }
  }
)

const processStripeEvent = async (stripe: Stripe, event: Stripe.Event): Promise<void> => {
  switch (event.type) {
  case "checkout.session.completed": {
    const session = event.data.object as Stripe.Checkout.Session
    const uid = session.metadata?.uid || session.client_reference_id
    if (!uid) {
      break
    }

    const protectedUserSnap = await db.doc(`users/${uid}`).get()
    const protectedUser = protectedUserSnap.data() as Users | undefined
    if (isBillingRestrictedUser(protectedUser)) {
      const restrictedSessionBilling = {
        ...getDefaultBillingForPlan("free"),
        plan: "free" as BillingPlanTier,
        status: "inactive",
        subscriptionId: null,
        planInterval: null as BillingInterval | null,
        updatedAt: FieldValue.serverTimestamp(),
      }
      await Promise.all([
        db.doc(`users/${uid}/billing/current`).set(restrictedSessionBilling, { merge: true }),
        db.doc(`users/${uid}`).set({
          billing: restrictedSessionBilling,
          plan: "free",
          status: "inactive",
          subscriptionId: null,
          stripeId: FieldValue.delete(),
          updated_At: new Date(),
        }, { merge: true }),
      ])
      break
    }

    const checkoutType = session.metadata?.checkoutType
    const selectedPlanId = session.metadata?.planId || "free"
    const selectedInterval = (session.metadata?.interval as BillingInterval) || "monthly"
    const billingRef = db.doc(`users/${uid}/billing/current`)
    const userRef = db.doc(`users/${uid}`)

    if (checkoutType === "credits" || checkoutType === "custom_credits") {
      const pack = creditPackCatalog.find((item) => item.id === selectedPlanId)
      const incrementBy = checkoutType === "custom_credits" ? Math.floor(Number(session.metadata?.customCredits || 0)) : (pack?.credits || 0)
      await addCreditsLedgerEntry({
        uid,
        delta: incrementBy,
        source: checkoutType === "custom_credits" ? "custom_credits_checkout" : "stripe_checkout",
        bucket: "purchased",
        reason: checkoutType === "custom_credits" ? "custom_credits" : "credit_pack",
        sessionId: session.id,
      })
    } else {
      const selectedPlan = mapPlanIdToTier(selectedPlanId)
      let trialMeta: Partial<UserBilling> = {}
      let effectivePlan: BillingPlanTier = selectedPlan
      let subscriptionMeta: Partial<UserBilling> = {}
      let effectiveStatus = "active"
      let effectiveSubscriptionId: string | null = typeof session.subscription === "string" ? session.subscription : null

      if (typeof session.subscription === "string") {
        const subscription = await stripe.subscriptions.retrieve(session.subscription)
        effectiveStatus = subscription.status
        effectiveSubscriptionId = subscription.id
        subscriptionMeta = getSubscriptionCycleFields(subscription)

        if (subscription.status === "trialing") {
          effectivePlan = "trial"
          trialMeta = {
            trialPlanTarget: selectedPlan,
            trialStartedAt: new Date(subscription.current_period_start * 1000).toISOString(),
            trialEndsAt: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
            trialUsedAt: new Date().toISOString(),
            trialCreditCapEur: TRIAL_DEFAULT_CREDIT_CAP_EUR,
          }
        }
      }

      const checkoutBilling = {
        ...getDefaultBillingForPlan(effectivePlan),
        status: effectiveStatus,
        subscriptionId: effectiveSubscriptionId,
        planInterval: selectedInterval,
        ...subscriptionMeta,
        ...trialMeta,
        updatedAt: FieldValue.serverTimestamp(),
      }

      await Promise.all([
        billingRef.set(checkoutBilling, { merge: true }),
        userRef.set({
          billing: checkoutBilling,
          plan: effectivePlan,
          status: effectiveStatus,
          subscriptionId: effectiveSubscriptionId,
          updated_At: new Date(),
        }, { merge: true }),
      ])

      if (checkoutType === "plan_payg") {
        const includedCredits = getIncludedCreditsForPlanInterval(selectedPlan, "payAsYouGo")
        await addCreditsLedgerEntry({
          uid,
          delta: includedCredits,
          source: "plan_payg_checkout",
          bucket: "included",
          reason: "plan_payg",
          sessionId: session.id,
          plan: selectedPlan,
          interval: "payAsYouGo",
        })
      }
    }

    // Payment analytics: only one-time checkouts land here. Subscription mode is
    // recorded from `invoice.paid` instead, so the same payment is never counted twice.
    if (session.mode === "payment") {
      await recordPaidFact(uid, {
        id: session.id,
        amountMinor: Number(session.amount_total || 0),
        currency: session.currency || "eur",
        source: checkoutType === "credits" || checkoutType === "custom_credits" ? "credits" : "payg",
        plan: selectedPlanId,
        interval: selectedInterval,
        reason: checkoutType || "one_time",
      })
    }
    break
  }
  case "invoice.payment_failed": {
    const invoice = event.data.object as Stripe.Invoice
    const uid = invoice.metadata?.uid || await resolveUidByStripeCustomer(invoice.customer)
    if (!uid) {
      break
    }

    const graceUntil = new Date(Date.now() + 1000 * 60 * 60 * 24 * 3).toISOString()
    const pastDueBilling = {
      status: "past_due",
      graceUntil,
      updatedAt: FieldValue.serverTimestamp(),
    }
    await Promise.all([
      db.doc(`users/${uid}/billing/current`).set(pastDueBilling, { merge: true }),
      // Sync billing to embedded user doc field (set replaces the whole billing object for consistency)
      db.doc(`users/${uid}`).set({ billing: pastDueBilling }, { merge: true }),
    ])

    await recordBillingIncident({
      type: "invoice.payment_failed",
      severity: "warning",
      eventId: event.id,
      eventType: event.type,
      uid,
      message: `Invoice payment failed. Grace period active until ${graceUntil}`,
      metadata: {
        invoiceId: invoice.id,
        amountDue: invoice.amount_due,
        currency: invoice.currency,
        customer: typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id || null,
        graceUntil,
      },
    })

    // Emit user-facing alert for the payment failure.
    await emitUsageAlert({
      uid,
      alertId: createAlertId("payment_failed", invoice.id),
      title: "Payment Failed",
      message: `Your most recent invoice payment of ${(invoice.amount_due / 100).toFixed(2)} ${invoice.currency.toUpperCase()} could not be processed. Your account will remain active until ${new Date(graceUntil).toLocaleDateString()}. Please update your payment method to avoid service interruption.`,
      severity: "warning",
      metadata: {
        invoiceId: invoice.id,
        amountDue: invoice.amount_due,
        currency: invoice.currency,
        graceUntil,
      },
    })
    break
  }
  case "invoice.paid": {
    const invoice = event.data.object as Stripe.Invoice
    const uid = invoice.metadata?.uid || await resolveUidByStripeCustomer(invoice.customer)
    if (!uid) {
      break
    }

    const billingRef = db.doc(`users/${uid}/billing/current`)
    const billingSnap = await billingRef.get()
    const billing = billingSnap.data() as UserBilling | undefined

    let plan: BillingPlanTier | undefined
    let planInterval: BillingInterval | undefined
    let features: Record<string, boolean> | undefined
    let trialFields: Partial<UserBilling> = {}
    const recurringPrice = getInvoiceRecurringPrice(invoice)
    const recurringMatch = inferRecurringPlanFromPriceId(recurringPrice?.id, recurringPrice?.lookupKey)

    if (recurringMatch) {
      plan = recurringMatch.plan
      planInterval = recurringMatch.interval
      features = getFeaturesFromPlan(plan)
    }

    if (billing?.plan === "trial" && billing.trialPlanTarget) {
      plan = billing.trialPlanTarget
      planInterval =
        billing.planInterval === "monthly" || billing.planInterval === "quarterly" || billing.planInterval === "annually" ?
          billing.planInterval :
          planInterval
      features = getFeaturesFromPlan(plan)
      trialFields = {
        trialPlanTarget: null,
        trialStartedAt: null,
        trialEndsAt: null,
      }
    }

    const subscriptionId = typeof invoice.subscription === "string" ? invoice.subscription : billing?.subscriptionId || null
    const shouldGrantIncludedCredits = Boolean(
      subscriptionId &&
      plan &&
      planInterval &&
      invoice.amount_paid > 0 &&
      recurringCreditGrantReasons.has(invoice.billing_reason || ""),
    )

    const invoicePaidBilling = {
      ...(billing ?? getDefaultBillingForPlan("free")),
      status: "active",
      ...(plan ? { plan } : {}),
      ...(planInterval ? { planInterval } : {}),
      ...(features ? { features } : {}),
      ...trialFields,
      graceUntil: null,
      updatedAt: FieldValue.serverTimestamp(),
    }

    await Promise.all([
      billingRef.set({
        status: "active",
        ...(plan ? { plan } : {}),
        ...(planInterval ? { planInterval } : {}),
        ...(features ? { features } : {}),
        ...trialFields,
        graceUntil: null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true }),
      syncBillingToUserDoc(db.doc(`users/${uid}`), invoicePaidBilling),
    ])

    if (shouldGrantIncludedCredits && plan && planInterval) {
      await addCreditsLedgerEntry({
        uid,
        delta: getIncludedCreditsForPlanInterval(plan, planInterval),
        source: "subscription_cycle",
        bucket: "included",
        reason: invoice.billing_reason || "subscription_cycle",
        invoiceId: invoice.id,
        subscriptionId,
        plan,
        interval: planInterval,
      })
    }

    if (plan) {
      await db.doc(`users/${uid}`).set({
        plan,
        status: "active",
        updated_At: new Date(),
      }, { merge: true })
    }

    // Emit user-facing receipt alert for the paid invoice.
    const invoiceLabel = invoice.number || invoice.id
    const receiptUrl = invoice.hosted_invoice_url || null
    await emitUsageAlert({
      uid,
      alertId: createAlertId("invoice_paid", invoice.id),
      title: "Payment Received",
      message: `Invoice ${invoiceLabel} for ${(invoice.amount_paid / 100).toFixed(2)} ${invoice.currency.toUpperCase()} has been paid successfully.${receiptUrl ? ` View receipt: ${receiptUrl}` : ""}`,
      severity: "info",
      metadata: {
        invoiceId: invoice.id,
        number: invoice.number,
        amountPaid: invoice.amount_paid,
        currency: invoice.currency,
        receiptUrl,
        billingReason: invoice.billing_reason,
      },
    })

    // Payment analytics: subscriptions are counted here (this fires for the first
    // payment too), never from the checkout session, so no euro is counted twice.
    await recordPaidFact(uid, {
      id: invoice.id,
      amountMinor: invoice.amount_paid,
      currency: invoice.currency,
      source: "subscription",
      plan: plan ?? billing?.plan ?? null,
      interval: planInterval ?? null,
      reason: invoice.billing_reason ?? null,
    })
    break
  }
  case "payment_intent.succeeded": {
    const paymentIntent = event.data.object as Stripe.PaymentIntent
    const uid = paymentIntent.metadata?.uid || await resolveUidByStripeCustomer(paymentIntent.customer)
    if (!uid) {
      break
    }

    const protectedUserSnap = await db.doc(`users/${uid}`).get()
    const protectedUser = protectedUserSnap.data() as Users | undefined
    if (isBillingRestrictedUser(protectedUser)) {
      break
    }

    const checkoutType = paymentIntent.metadata?.checkoutType
    const selectedPlanId = paymentIntent.metadata?.planId

    const inferredPlan = selectedPlanId ? mapPlanIdToTier(selectedPlanId) : inferPayAsYouGoPlanFromPayment({
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
    })

    if (checkoutType === "credits") {
      break
    }

    if (!inferredPlan || inferredPlan === "free" || inferredPlan === "trial") {
      break
    }

    const paymentIntentBilling = {
      ...getDefaultBillingForPlan(inferredPlan),
      plan: inferredPlan,
      planInterval: "payAsYouGo" as BillingInterval,
      status: "active",
      cancelAtPeriodEnd: false,
      cancelAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      updatedAt: FieldValue.serverTimestamp(),
    }

    await Promise.all([
      db.doc(`users/${uid}/billing/current`).set(paymentIntentBilling, { merge: true }),
      syncBillingToUserDoc(db.doc(`users/${uid}`), paymentIntentBilling),
    ])

    if (!checkoutType) {
      await addCreditsLedgerEntry({
        uid,
        delta: getIncludedCreditsForPlanInterval(inferredPlan, "payAsYouGo"),
        source: "plan_payg_payment_intent",
        bucket: "included",
        reason: "plan_payg",
        paymentIntentId: paymentIntent.id,
        plan: inferredPlan,
        interval: "payAsYouGo",
      })
    }

    await db.doc(`users/${uid}`).set({
      plan: inferredPlan,
      status: "active",
      updated_At: new Date(),
    }, { merge: true })
    break
  }
  case "customer.subscription.created":
  case "customer.subscription.updated": {
    const subscription = event.data.object as Stripe.Subscription
    const uid = subscription.metadata?.uid || await resolveUidByStripeCustomer(subscription.customer)
    if (!uid) {
      break
    }

    const protectedUserSnap = await db.doc(`users/${uid}`).get()
    const protectedUser = protectedUserSnap.data() as Users | undefined
    if (isBillingRestrictedUser(protectedUser)) {
      break
    }

    // previous_attributes comes from the Stripe webhook event payload, not the subscription object.
    const eventWithPrev = event as unknown as { previous_attributes?: { items?: { data?: Array<{ price?: { id?: string } }> } } }
    const previousPriceId = eventWithPrev.previous_attributes?.items?.data?.[0]?.price?.id
    const recurringPrice = subscription.items.data[0]?.price
    const recurringMatch = inferRecurringPlanFromPriceId(recurringPrice?.id, recurringPrice?.lookup_key)
    if (!recurringMatch) {
      break
    }

    // Detect plan changes from Stripe Customer Portal (price ID changed). The previous
    // price arrives as a partial object (changed fields only), so it usually carries no
    // lookup_key; matching it by id is enough to notice that a change happened.
    const previousMatch = previousPriceId && previousPriceId !== recurringPrice?.id ?
      inferRecurringPlanFromPriceId(previousPriceId) :
      null
    const planChanged = previousMatch !== null &&
      (previousMatch.plan !== recurringMatch.plan || previousMatch.interval !== recurringMatch.interval)

    if (planChanged) {
      await recordBillingIncident({
        type: "customer.subscription.plan_changed_via_portal",
        severity: "info",
        eventId: event.id,
        eventType: event.type,
        uid,
        message: `Subscription plan changed via Stripe Portal: ${previousMatch?.plan || "unknown"}/${previousMatch?.interval || "unknown"} → ${recurringMatch.plan}/${recurringMatch.interval}`,
        metadata: {
          subscriptionId: subscription.id,
          previousPlan: previousMatch?.plan || null,
          previousInterval: previousMatch?.interval || null,
          newPlan: recurringMatch.plan,
          newInterval: recurringMatch.interval,
          previousPriceId,
          newPriceId: recurringPrice?.id,
        },
      })
    }

    const effectivePlan: BillingPlanTier = subscription.status === "trialing" ? "trial" : recurringMatch.plan

    const subscriptionBilling = {
      plan: effectivePlan,
      planInterval: recurringMatch.interval,
      status: subscription.status,
      subscriptionId: subscription.id,
      features: getFeaturesFromPlan(effectivePlan),
      ...getSubscriptionCycleFields(subscription),
      ...(subscription.status === "trialing" ? {
        trialPlanTarget: recurringMatch.plan,
        trialStartedAt: new Date(subscription.current_period_start * 1000).toISOString(),
        trialEndsAt: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
        trialUsedAt: new Date().toISOString(),
        trialCreditCapEur: TRIAL_DEFAULT_CREDIT_CAP_EUR,
      } : {
        trialPlanTarget: null,
        trialStartedAt: null,
        trialEndsAt: null,
      }),
      updatedAt: FieldValue.serverTimestamp(),
    }

    await Promise.all([
      db.doc(`users/${uid}/billing/current`).set(subscriptionBilling, { merge: true }),
      db.doc(`users/${uid}`).set({
        billing: subscriptionBilling,
        plan: effectivePlan,
        status: subscription.status,
        subscriptionId: subscription.id,
        updated_At: new Date(),
      }, { merge: true }),
    ])
    break
  }
  case "customer.subscription.deleted": {
    const subscription = event.data.object as Stripe.Subscription
    const uid = subscription.metadata?.uid || await resolveUidByStripeCustomer(subscription.customer)
    if (!uid) {
      break
    }

    const cancelledBilling = {
      ...getDefaultBillingForPlan("free"),
      status: "inactive",
      cancelAtPeriodEnd: false,
      cancelAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      updatedAt: FieldValue.serverTimestamp(),
    }

    await Promise.all([
      db.doc(`users/${uid}/billing/current`).set(cancelledBilling, { merge: true }),
      db.doc(`users/${uid}`).set({
        billing: cancelledBilling,
        plan: "free",
        status: "inactive",
        subscriptionId: null,
        updated_At: new Date(),
      }, { merge: true }),
    ])
    break
  }
  case "payment_intent.payment_failed": {
    const failedPi = event.data.object as Stripe.PaymentIntent
    const failedUid = failedPi.metadata?.uid || await resolveUidByStripeCustomer(failedPi.customer)
    if (!failedUid) {
      break
    }

    await recordBillingIncident({
      type: "payment_intent.payment_failed",
      severity: "warning",
      eventId: event.id,
      eventType: event.type,
      uid: failedUid,
      message: `Payment intent ${failedPi.id} failed: ${failedPi.last_payment_error?.message || "unknown error"}`,
      metadata: {
        paymentIntentId: failedPi.id,
        amount: failedPi.amount,
        currency: failedPi.currency,
        lastPaymentError: failedPi.last_payment_error?.message || null,
        code: failedPi.last_payment_error?.code || null,
        declineCode: failedPi.last_payment_error?.decline_code || null,
      },
    })
    break
  }
  case "charge.dispute.created": {
    const dispute = event.data.object as Stripe.Dispute
    const disputeCustomerId = typeof dispute.charge === "string"?
      dispute.charge : (dispute.charge as Stripe.Charge | null)?.customer || null
    const disputeUid = dispute.metadata?.uid || await resolveUidByStripeCustomer(disputeCustomerId)
    if (!disputeUid) {
      break
    }

    await recordBillingIncident({
      type: "charge.dispute.created",
      severity: "error",
      eventId: event.id,
      eventType: event.type,
      uid: disputeUid,
      message: `Dispute filed for charge ${dispute.charge}: ${dispute.reason || "no reason given"}`,
      metadata: {
        disputeId: dispute.id,
        chargeId: typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id || null,
        amount: dispute.amount,
        currency: dispute.currency,
        reason: dispute.reason,
        status: dispute.status,
        evidenceRequiredBy: dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000).toISOString() : null,
      },
    })
    break
  }
  case "charge.refunded": {
    const charge = event.data.object as Stripe.Charge
    const refundUid = charge.metadata?.uid || await resolveUidByStripeCustomer(charge.customer)
    if (!refundUid) {
      break
    }

    const refundedAmount = charge.amount_refunded || 0
    await recordBillingIncident({
      type: "charge.refunded",
      severity: refundedAmount >= charge.amount ? "warning" : "info",
      eventId: event.id,
      eventType: event.type,
      uid: refundUid,
      message: `Charge ${charge.id} refunded ${refundedAmount} ${charge.currency}`,
      metadata: {
        chargeId: charge.id,
        amountRefunded: refundedAmount,
        amount: charge.amount,
        currency: charge.currency,
        refunded: charge.refunded,
        paymentIntentId: charge.payment_intent || null,
      },
    })
    break
  }
  case "payment_method.attached": {
    const pm = event.data.object as Stripe.PaymentMethod
    if (pm.type !== "card" || !pm.customer) {
      break
    }

    const pmUid = await resolveUidByStripeCustomer(pm.customer)
    if (!pmUid) {
      break
    }

    // Store the payment method reference in user's subcollection for tracking
    const pmRef = db.doc(`users/${pmUid}/payment_methods/${pm.id}`)
    await pmRef.set({
      type: pm.type,
      brand: pm.card?.brand || null,
      last4: pm.card?.last4 || null,
      expMonth: pm.card?.exp_month || null,
      expYear: pm.card?.exp_year || null,
      billingDetails: pm.billing_details?.email || null,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    break
  }
  case "payment_method.detached": {
    const detachedPm = event.data.object as Stripe.PaymentMethod
    if (!detachedPm.customer) {
      break
    }

    const detachedUid = await resolveUidByStripeCustomer(detachedPm.customer)
    if (!detachedUid) {
      break
    }

    // Remove the payment method reference
    const detachedRef = db.doc(`users/${detachedUid}/payment_methods/${detachedPm.id}`)
    await detachedRef.delete().catch(() => undefined)
    break
  }
  case "setup_intent.succeeded": {
    const setupIntent = event.data.object as Stripe.SetupIntent
    const setupUid = setupIntent.metadata?.uid || await resolveUidByStripeCustomer(setupIntent.customer)
    if (!setupUid) {
      break
    }

    // Update any pending setup intent cart references
    const setupCarts = await db.collection(`users/${setupUid}/paymentcart`)
      .where("setupIntentId", "==", setupIntent.id)
      .limit(1)
      .get()

    if (!setupCarts.empty) {
      await setupCarts.docs[0].ref.set({
        status: "succeeded",
        lastPaymentAttempt: new Date().toISOString(),
      }, { merge: true })
    }
    break
  }
  case "setup_intent.canceled": {
    const canceledSetup = event.data.object as Stripe.SetupIntent
    const canceledSetupUid = canceledSetup.metadata?.uid || await resolveUidByStripeCustomer(canceledSetup.customer)
    if (!canceledSetupUid) {
      break
    }

    const canceledCarts = await db.collection(`users/${canceledSetupUid}/paymentcart`)
      .where("setupIntentId", "==", canceledSetup.id)
      .limit(1)
      .get()

    if (!canceledCarts.empty) {
      await canceledCarts.docs[0].ref.set({
        status: "canceled",
        lastPaymentAttempt: new Date().toISOString(),
      }, { merge: true })
    }
    break
  }
  case "customer.updated": {
    const customer = event.data.object as Stripe.Customer
    const custUid = customer.metadata?.firebaseUID || await resolveUidByStripeCustomer(customer.id)
    if (!custUid) {
      break
    }

    // Sync Stripe customer email/name changes to Firestore metadata
    const syncFields: Record<string, unknown> = {}
    if (customer.email) {
      syncFields["stripeEmail"] = customer.email
    }
    if (customer.name) {
      syncFields["stripeName"] = customer.name
    }
    if (customer.invoice_settings?.default_payment_method) {
      const defaultPm = typeof customer.invoice_settings.default_payment_method === "string"?
       customer.invoice_settings.default_payment_method :
       customer.invoice_settings.default_payment_method?.id || null
      if (defaultPm) {
        syncFields["stripeDefaultPaymentMethod"] = defaultPm
      }
    }

    if (Object.keys(syncFields).length > 0) {
      await db.doc(`users/${custUid}`).set(syncFields, { merge: true })
    }
    break
  }
  case "invoice.created":
  case "invoice.finalized": {
    const invEvent = event.data.object as Stripe.Invoice
    const invUid = invEvent.metadata?.uid || await resolveUidByStripeCustomer(invEvent.customer)
    if (!invUid) {
      break
    }

    // Store invoice record for observability
    const invoiceRef = db.doc(`users/${invUid}/invoices/${invEvent.id}`)
    await invoiceRef.set({
      id: invEvent.id,
      number: invEvent.number,
      status: invEvent.status,
      total: invEvent.total,
      amountPaid: invEvent.amount_paid,
      amountDue: invEvent.amount_due,
      currency: invEvent.currency,
      hostedInvoiceUrl: invEvent.hosted_invoice_url,
      invoicePdf: invEvent.invoice_pdf,
      periodStart: invEvent.period_start ? new Date(invEvent.period_start * 1000).toISOString() : null,
      periodEnd: invEvent.period_end ? new Date(invEvent.period_end * 1000).toISOString() : null,
      billingReason: invEvent.billing_reason,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    break
  }
  case "invoice.voided": {
    const voidedInv = event.data.object as Stripe.Invoice
    const voidedUid = voidedInv.metadata?.uid || await resolveUidByStripeCustomer(voidedInv.customer)
    if (!voidedUid) {
      break
    }

    const voidedRef = db.doc(`users/${voidedUid}/invoices/${voidedInv.id}`)
    await voidedRef.set({
      status: "voided",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })

    await recordBillingIncident({
      type: "invoice.voided",
      severity: "warning",
      eventId: event.id,
      eventType: event.type,
      uid: voidedUid,
      message: `Invoice ${voidedInv.id} was voided`,
      metadata: {
        invoiceId: voidedInv.id,
        number: voidedInv.number,
        amount: voidedInv.total,
        currency: voidedInv.currency,
      },
    })
    break
  }
  case "invoice.upcoming": {
    // Fires the configured number of days before a renewal is charged - the only warning
    // this platform gets before money moves. The Invoice in this payload deliberately has
    // NO id (it does not exist yet), so the renewal is the identity: one alert per
    // subscription per period, or Stripe's repeated sends would mint an alert each time.
    const upcoming = event.data.object as Stripe.Invoice
    const upcomingUid = upcoming.metadata?.uid || await resolveUidByStripeCustomer(upcoming.customer)
    if (!upcomingUid) {
      break
    }

    const subscriptionRef = upcoming.subscription
    const upcomingSubscriptionId = typeof subscriptionRef === "string" ? subscriptionRef : subscriptionRef?.id || null
    const upcomingAmount = Number(upcoming.amount_due || 0)
    if (!upcomingSubscriptionId || upcomingAmount <= 0) {
      break
    }

    // A renewal is not an incident, so this does not touch billing_incidents: one admin
    // row per subscriber per month would bury the rows an operator acts on. Duplicates
    // Stripe's own renewal email when that Dashboard setting is on, but this is where the
    // customer can actually fix the card.
    const chargeAtMs = (upcoming.next_payment_attempt || upcoming.period_start) * 1000
    await emitUsageAlert({
      uid: upcomingUid,
      alertId: createAlertId("invoice_upcoming", `${upcomingSubscriptionId}_${upcoming.period_start}`),
      title: "Upcoming charge",
      message: `Your subscription renews for ${(upcomingAmount / 100).toFixed(2)} ` +
        `${upcoming.currency.toUpperCase()} on ${new Date(chargeAtMs).toLocaleDateString()}. ` +
        "Update your payment method before then if anything has changed.",
      severity: "info",
      metadata: {
        amountDue: upcomingAmount,
        currency: upcoming.currency,
        subscriptionId: upcomingSubscriptionId,
        chargeAt: new Date(chargeAtMs).toISOString(),
        billingReason: upcoming.billing_reason,
      },
    })
    break
  }
  default: {
    // Catch billing.meter events that are not in the Stripe SDK type union.
    const rawType = (event as unknown as { type: string }).type
    if (rawType === "billing.meter.error_report_triggered") {
      const rawMeter = event as unknown as { data?: { object?: Record<string, unknown> } }
      const meterObj = rawMeter?.data?.object || {}
      const meterCustomer = meterObj["customer"] as string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined
      const meterUid = await resolveUidByStripeCustomer(meterCustomer)
      if (meterUid) {
        const rawMeterEvent = event as unknown as { id: string; type: string }
        await recordBillingIncident({
          type: "billing.meter.error_report_triggered",
          severity: "error",
          eventId: rawMeterEvent.id,
          eventType: rawMeterEvent.type,
          uid: meterUid,
          message: `Billing meter error reported for meter ${String(meterObj["meter_id"] || "unknown")}`,
          metadata: {
            meterId: (meterObj["meter_id"] as string) || null,
            customer: typeof meterCustomer === "string" ? meterCustomer : (meterCustomer as Stripe.Customer | null)?.id || null,
          },
        })
      }
    }
    break
  }
  }
}

// Which deployment is answering. Everything the body used to read from the module - the
// secrets to verify with, the mode to accept - arrives as a parameter, because production
// and sandbox must not share either. A secret name holds ONE value per project, so a single
// function could only ever verify one endpoint's signature and the other endpoint got a 400
// on every delivery; `expectLivemode` also replaces the `env.IS_PRODUCTION` check, which
// conflated "deployed in production" with "this endpoint serves live events".
type StripeWebhookBinding = {
  secrets: SecretParam[]
  stripeKeyName: string
  webhookSecretName: string
  expectLivemode: boolean
}

// The response object `onRequest` hands its callback, derived so express does not have to be
// imported just to name it.
type StripeWebhookResponse = Parameters<HttpsFunction>[1]

/**
 * Verify one Stripe delivery and apply it, for whichever deployment is bound.
 * @param {*} req Request carrying the raw body the signature is computed over.
 * @param {*} res Response to acknowledge or reject with.
 * @param {*} binding Which function is answering: its secrets, key names and mode.
 * @return {*} Resolves after the response has been sent.
 */
async function processStripeWebhookRequest(
  req: Request,
  res: StripeWebhookResponse,
  binding: StripeWebhookBinding,
): Promise<void> {
    const stripeSecret: string | undefined = binding.secrets.find((secret) => secret.name === binding.stripeKeyName)?.value()
    const stripe = getStripe(stripeSecret)
    const webhookSecret: string | undefined = binding.secrets.find((secret) => secret.name === binding.webhookSecretName)?.value()
    const stripeWebhookSecret = getStripeWebhookSecret(webhookSecret)
    if (!stripeWebhookSecret) {
      console.error(`Missing ${binding.webhookSecretName}`)
      res.status(500).send("Webhook secret missing")
      return
    }

    const signature = req.headers["stripe-signature"]
    if (!signature || Array.isArray(signature)) {
      res.status(400).send("Missing stripe signature")
      return
    }

    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, signature, stripeWebhookSecret)
    } catch (error) {
      console.error("Webhook signature verification failed", error)
      res.status(400).send("Invalid signature")
      return
    }

    // One endpoint, one mode: the live function must never act on a sandbox event, and the
    // sandbox function must never act on a live one, so the expected mode travels with the
    // binding instead of being inferred from the environment the code happens to run in.
    if (event.livemode !== binding.expectLivemode) {
      const eventMode = event.livemode ? "live-mode" : "test-mode"
      console.warn(`Ignoring ${eventMode} Stripe event ${event.id} on the ${binding.expectLivemode ? "live" : "sandbox"} endpoint`)
      res.status(200).send(`Ignored ${eventMode} event`)
      return
    }

    const eventRef = db.doc(`stripe_events/${event.id}`)
    try {
      await eventRef.create({
        type: event.type,
        // Both functions write to this collection and event ids are unique per mode, so
        // without this a failed sandbox delivery reads as a failed live one in the panel.
        livemode: event.livemode,
        processed: false,
        failed: false,
        retryCount: 0,
        processingStartedAt: FieldValue.serverTimestamp(),
      })
    } catch {
      const existingEvent = await eventRef.get()
      const existingData = existingEvent.data() as { processed?: boolean } | undefined
      if (existingData?.processed === true) {
        res.status(200).send("Already processed")
        return
      }

      await eventRef.set({
        failed: false,
        lastRetryAt: FieldValue.serverTimestamp(),
        retryCount: FieldValue.increment(1),
        processingStartedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
    }

    try {
      await processStripeEvent(stripe, event)

      await eventRef.set({
        type: event.type,
        processed: true,
        failed: false,
        lastError: null,
        processedAt: FieldValue.serverTimestamp(),
      }, { merge: true })

      res.status(200).send("ok")
    } catch (error) {
      console.error("stripeWebhook processing failed", error)
      const errorMessage = toSafeErrorMessage(error)
      await eventRef.set({
        processed: false,
        failed: true,
        lastError: errorMessage,
        failedAt: FieldValue.serverTimestamp(),
      }, { merge: true })

      await recordBillingIncident({
        type: "stripe.webhook.processing_failed",
        severity: "error",
        eventId: event.id,
        eventType: event.type,
        message: errorMessage,
        metadata: {
          livemode: event.livemode,
          pendingWebhooks: event.pending_webhooks,
        },
      })
      res.status(500).send("Webhook processing error")
    }
}

export const stripeWebhook = onRequest({ secrets: stripeSecrets }, (req, res) =>
  processStripeWebhookRequest(req, res, {
    secrets: stripeSecrets,
    stripeKeyName: "STRIPE_SECRET_KEY",
    webhookSecretName: "STRIPE_WEBHOOK_SECRET",
    expectLivemode: env.IS_PRODUCTION,
  }))

// The sandbox twin: its own URL, its own signing secret, its own Stripe key, test-mode events
// only. Point the Stripe test-mode endpoint here instead of at the production function.
export const stripeWebhookTest = onRequest({ secrets: stripeTestSecrets }, (req, res) =>
  processStripeWebhookRequest(req, res, {
    secrets: stripeTestSecrets,
    stripeKeyName: "STRIPE_SECRET_KEY_TEST",
    webhookSecretName: "STRIPE_WEBHOOK_SECRET_TEST",
    expectLivemode: false,
  }))

export const updateUsage = onDocumentCreated(
  {
    document: "projects/{projectId}",
    database: dbName,
    secrets: stripeSecrets,
  },
  async (event) => {
    const snap = event.data
    if (!snap) {
      return
    }
    const secret: string | undefined = stripeSecrets.find((secret) => secret.name === "STRIPE_SECRET_KEY")?.value()
    const stripe = getStripe(secret)
    const project = snap.data() as { userId?: string }
    const userId = project?.userId
    if (!userId) {
      return
    }

    const userRef = db.doc(`users/${userId}`)

    const userDoc = await userRef.get()
    const user = userDoc.data()

    if (!user?.stripeId || !user?.itemId) {
      return
    }

    await stripe.billing.meterEvents.create(
      {
        event_name: "blaze_plan_monthly",
        payload: {
          "stripe_customer_id": user.stripeId,
          "value": "1",
        },
        timestamp: Math.floor(snap.createTime.toDate().getTime() / 1000),
      },
      {
        idempotencyKey: snap.id,
      },
    )
    await stripe.subscriptionItems.createUsageRecord(
      user.itemId,
      {
        quantity: 1,
        action: "increment",
        timestamp: Math.floor(snap.createTime.toDate().getTime() / 1000),
      },
      {
        idempotencyKey: snap.id,
      },
    )

    const nextUsage = Number(user?.currentUsage || 0) + 1
    const userPlan = mapPlanIdToTier(user?.plan || "free")
    const usageCap = usageCapsByPlan[userPlan]
    const usageRatio = usageCap > 0 ? nextUsage / usageCap : 0
    const periodWindow = new Date().toISOString().slice(0, 7)

    const alertWrites = usageThresholds
      .filter((threshold) => usageRatio >= threshold)
      .map((threshold) => {
        const percent = Math.round(threshold * 100)
        return emitUsageAlert({
          uid: userId,
          alertId: createAlertId(`usage_${percent}`, periodWindow),
          title: `Usage at ${percent}%`,
          message: `You have reached ${nextUsage}/${usageCap} included units for your ${userPlan} plan.`,
          severity: threshold >= 1 ? "error" : threshold >= 0.9 ? "warning" : "info",
          metadata: {
            currentUsage: nextUsage,
            includedUsage: usageCap,
            plan: userPlan,
            ratio: usageRatio,
          },
        })
      })

    await Promise.all(alertWrites)

    const billingRef = db.doc(`users/${userId}/billing/current`)
    const billingSnap = await billingRef.get()
    if (billingSnap.exists) {
      const billing = billingSnap.data() as UserBilling
      const creditBalance = getPurchasedCreditsAvailable(billing)

      if (creditBalance <= 20) {
        await emitUsageAlert({
          uid: userId,
          alertId: createAlertId("credits_low", periodWindow),
          title: "Credits running low",
          message: `Remaining credits: ${Math.max(0, creditBalance)}. Consider topping up to avoid interruptions.`,
          severity: creditBalance <= 5 ? "warning" : "info",
          metadata: { creditBalance },
        })
      }
    }

    return userRef.update({ currentUsage: nextUsage })
  })

export const grantPromotionalCredits = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const actorUid = req.auth?.uid
    if (!actorUid) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const tokenRole = getTokenRole(req)
    if (!isPlatformAdminRole(tokenRole)) {
      throw new HttpsError("permission-denied", "Only admins can grant promotional credits")
    }

    const { targetUserId, credits, reason = "promotional_credit" } = req.data as {
      targetUserId: string
      credits: number
      reason?: string
    }

    const normalizedTargetUserId = String(targetUserId || "").trim()
    const normalizedReason = String(reason || "").trim() || "promotional_credit"

    if (!normalizedTargetUserId || !Number.isFinite(credits) || credits <= 0) {
      throw new HttpsError("invalid-argument", "targetUserId and positive credits are required")
    }

    const normalizedCredits = Math.floor(credits)

    await addCreditsLedgerEntry({
      uid: normalizedTargetUserId,
      delta: normalizedCredits,
      source: "promotional_credit",
      bucket: "purchased",
      grantedBy: actorUid,
      reason: normalizedReason,
    })

    await db.collection("audit_logs").add({
      action: "admin_grant_promotional_credits",
      admin_uid: actorUid,
      target_userId: normalizedTargetUserId,
      credits: normalizedCredits,
      reason: normalizedReason,
      timestamp: FieldValue.serverTimestamp(),
    })

    return { ok: true, targetUserId: normalizedTargetUserId, grantedCredits: normalizedCredits }
  },
)

export const getAdminBillingObservability = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const actorUid = req.auth?.uid
    if (!actorUid) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const tokenRole = getTokenRole(req)
    if (!isPlatformAdminRole(tokenRole)) {
      throw new HttpsError("permission-denied", "Only admins can access billing observability")
    }

    const {
      incidentLimit: rawIncidentLimit = 20,
      failedEventLimit: rawFailedEventLimit = 20,
      pendingEventLimit: rawPendingEventLimit = 20,
      pastDueLimit: rawPastDueLimit = 30,
      includeAcknowledged = false,
    } = (req.data || {}) as {
      incidentLimit?: number
      failedEventLimit?: number
      pendingEventLimit?: number
      pastDueLimit?: number
      includeAcknowledged?: boolean
    }

    const incidentLimit = Math.max(1, Math.min(100, Math.floor(Number(rawIncidentLimit) || 20)))
    const failedEventLimit = Math.max(1, Math.min(100, Math.floor(Number(rawFailedEventLimit) || 20)))
    const pendingEventLimit = Math.max(1, Math.min(100, Math.floor(Number(rawPendingEventLimit) || 20)))
    const pastDueLimit = Math.max(1, Math.min(200, Math.floor(Number(rawPastDueLimit) || 30)))

    const incidentsOrderedQuery = includeAcknowledged ?
      db.collection("billing_incidents").orderBy("createdAt", "desc") :
      db.collection("billing_incidents").where("acknowledged", "==", false).orderBy("createdAt", "desc")

    let incidentsDocs: FirebaseFirestore.QueryDocumentSnapshot[] = []
    let failedEventsDocs: FirebaseFirestore.QueryDocumentSnapshot[] = []
    let pendingEventsRawDocs: FirebaseFirestore.QueryDocumentSnapshot[] = []
    let pastDueDocs: FirebaseFirestore.QueryDocumentSnapshot[] = []

    const fetchPastDueAccountsIndexLight = async (): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> => {
      try {
        const usersPastDueSnap = await db.collection("users")
          .where("billing.status", "==", "past_due")
          .limit(Math.max(pastDueLimit * 3, pastDueLimit))
          .get()

        return sortDocsByTimestampDesc(usersPastDueSnap.docs, "billing.updatedAt").slice(0, pastDueLimit)
      } catch (error) {
        if (!isFirestoreFailedPrecondition(error)) {
          throw error
        }

        const scanLimit = Math.max(pastDueLimit * 25, 500)
        const usersScanSnap = await db.collection("users")
          .limit(scanLimit)
          .get()

        const filteredPastDueDocs = usersScanSnap.docs.filter((doc) => {
          const data = doc.data() as { billing?: { status?: unknown } }
          return data.billing?.status === "past_due"
        })

        return sortDocsByTimestampDesc(filteredPastDueDocs, "billing.updatedAt").slice(0, pastDueLimit)
      }
    }

    try {
      const [incidentsSnap, failedEventsSnap, pendingEventsRawSnap, pastDueSnap] = await Promise.all([
        incidentsOrderedQuery
          .limit(incidentLimit)
          .get(),
        db.collection("stripe_events")
          .where("failed", "==", true)
          .orderBy("failedAt", "desc")
          .limit(failedEventLimit)
          .get(),
        db.collection("stripe_events")
          .where("processed", "==", false)
          .orderBy("processingStartedAt", "desc")
          .limit(Math.max(pendingEventLimit * 3, pendingEventLimit))
          .get(),
        db.collectionGroup("billing")
          .where("status", "==", "past_due")
          .limit(pastDueLimit)
          .get(),
      ])

          incidentsDocs = incidentsSnap.docs
          failedEventsDocs = failedEventsSnap.docs
          pendingEventsRawDocs = pendingEventsRawSnap.docs
          pastDueDocs = pastDueSnap.docs
    } catch (error) {
      if (!isFirestoreFailedPrecondition(error)) {
        throw error
      }

      console.warn("Falling back to index-light billing observability queries", {
        dbName,
        reason: toSafeErrorMessage(error),
      })

      const [incidentsRawSnap, failedEventsRawSnap, pendingEventsFallbackSnap] = await Promise.all([
        (includeAcknowledged ?
          db.collection("billing_incidents") :
          db.collection("billing_incidents").where("acknowledged", "==", false))
          .limit(Math.max(incidentLimit * 4, incidentLimit))
          .get(),
        db.collection("stripe_events")
          .where("failed", "==", true)
          .limit(Math.max(failedEventLimit * 5, failedEventLimit))
          .get(),
        db.collection("stripe_events")
          .where("processed", "==", false)
          .limit(Math.max(pendingEventLimit * 7, pendingEventLimit))
          .get(),
      ])

      incidentsDocs = sortDocsByTimestampDesc(incidentsRawSnap.docs, "createdAt").slice(0, incidentLimit)
      failedEventsDocs = sortDocsByTimestampDesc(failedEventsRawSnap.docs, "failedAt").slice(0, failedEventLimit)
      pendingEventsRawDocs = sortDocsByTimestampDesc(pendingEventsFallbackSnap.docs, "processingStartedAt")
        .slice(0, Math.max(pendingEventLimit * 3, pendingEventLimit))
      pastDueDocs = await fetchPastDueAccountsIndexLight()
    }

    const incidents = incidentsDocs.map((doc) => {
      const data = doc.data() as Record<string, unknown>
      return {
        id: doc.id,
        ...data,
        createdAt: timestampToIso(data.createdAt),
        acknowledgedAt: timestampToIso(data.acknowledgedAt),
      }
    })

    const failedEvents = failedEventsDocs.map((doc) => {
      const data = doc.data() as Record<string, unknown>
      return {
        id: doc.id,
        type: data.type || null,
        retryCount: Number(data.retryCount || 0),
        lastError: data.lastError || null,
        failedAt: timestampToIso(data.failedAt),
        lastRetryAt: timestampToIso(data.lastRetryAt),
      }
    })

    const pendingEvents = pendingEventsRawDocs
      .filter((doc) => {
        const data = doc.data() as { failed?: boolean }
        return data.failed !== true
      })
      .slice(0, pendingEventLimit)
      .map((doc) => {
        const data = doc.data() as Record<string, unknown>
        return {
          id: doc.id,
          type: data.type || null,
          retryCount: Number(data.retryCount || 0),
          processingStartedAt: timestampToIso(data.processingStartedAt),
          lastRetryAt: timestampToIso(data.lastRetryAt),
        }
      })

    const pastDueAccounts = pastDueDocs.map((doc) => {
      const data = doc.data() as Record<string, unknown>
      const billingRecord = (data.billing && typeof data.billing === "object") ?
        (data.billing as Record<string, unknown>) :
        null
      const pathSegments = doc.ref.path.split("/")
      const uid = pathSegments.length >= 2 ? pathSegments[1] : null

      return {
        uid,
        path: doc.ref.path,
        graceUntil: typeof data.graceUntil === "string" ?
          data.graceUntil :
          (typeof billingRecord?.graceUntil === "string" ? billingRecord.graceUntil : null),
        updatedAt: timestampToIso(data.updatedAt) || timestampToIso(billingRecord?.updatedAt),
        subscriptionId: data.subscriptionId || billingRecord?.subscriptionId || null,
        plan: data.plan || billingRecord?.plan || null,
        status: data.status || billingRecord?.status || null,
      }
    })

    // --- Additional observability signals ---

    // 1. Dispute incidents (charge.dispute.created, etc.)
    let disputeDocs: FirebaseFirestore.QueryDocumentSnapshot[] = []
    try {
      const disputeSnap = await db.collection("billing_incidents")
        .where("type", ">=", "charge.dispute.")
        .where("type", "<", "charge.dispute.\uf8ff")
        .orderBy("createdAt", "desc")
        .limit(20)
        .get()
      disputeDocs = disputeSnap.docs
    } catch {
      // Index not available — skip
    }

    const disputes = disputeDocs.map((doc) => {
      const data = doc.data() as Record<string, unknown>
      return {
        id: doc.id,
        type: data.type || null,
        severity: data.severity || null,
        uid: data.uid || null,
        message: data.message || null,
        createdAt: timestampToIso(data.createdAt),
        acknowledged: Boolean(data.acknowledged),
        metadata: (data.metadata && typeof data.metadata === "object") ? data.metadata : null,
      }
    })

    // 2. Retry statistics — compute from failed events
    const totalRetries = failedEventsDocs.reduce((sum, doc) => {
      const data = doc.data() as { retryCount?: number }
      return sum + Number(data.retryCount || 0)
    }, 0)
    const retryStats = {
      totalFailedEvents: failedEventsDocs.length,
      totalRetries,
      averageRetries: failedEventsDocs.length > 0 ?
        Math.round((totalRetries / failedEventsDocs.length) * 100) / 100 :
        0,
      oldestUnprocessedEvent: pendingEvents.length > 0 ?
        pendingEvents[pendingEvents.length - 1]?.processingStartedAt || null :
        null,
    }

    // 3. Entitlement metrics for the current day
    let todaysEntitlementCalls = 0
    try {
      const todayKey = new Date().toISOString().slice(0, 10)
      const metricSnap = await db.doc(`billing_entitlement_metrics/${todayKey}`).get()
      if (metricSnap.exists) {
        const data = metricSnap.data() as { totalCalls?: number } | undefined
        todaysEntitlementCalls = Number(data?.totalCalls || 0)
      }
    } catch {
      // Best-effort
    }

    return {
      generatedAt: new Date().toISOString(),
      incidents,
      failedEvents,
      pendingEvents,
      pastDueAccounts,
      disputes,
      retryStats,
      entitlementMetrics: {
        todayCalls: todaysEntitlementCalls,
      },
    }
  },
)

export const acknowledgeBillingIncident = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const actorUid = req.auth?.uid
    if (!actorUid) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const tokenRole = getTokenRole(req)
    if (!isPlatformAdminRole(tokenRole)) {
      throw new HttpsError("permission-denied", "Only admins can acknowledge incidents")
    }

    const incidentId = String((req.data as { incidentId?: string })?.incidentId || "").trim()
    if (!incidentId) {
      throw new HttpsError("invalid-argument", "incidentId is required")
    }

    const incidentRef = db.doc(`billing_incidents/${incidentId}`)
    const incidentSnap = await incidentRef.get()
    if (!incidentSnap.exists) {
      throw new HttpsError("not-found", "Incident not found")
    }

    await incidentRef.set({
      acknowledged: true,
      acknowledgedBy: actorUid,
      acknowledgedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })

    return { ok: true, incidentId }
  },
)

export const requestStripeEventRetry = onCallv2(
  { secrets: stripeSecrets, enforceAppCheck: false },
  async (req) => {
    const actorUid = req.auth?.uid
    if (!actorUid) {
      throw new HttpsError("unauthenticated", "User must be authenticated")
    }

    const tokenRole = getTokenRole(req)
    if (!isPlatformAdminRole(tokenRole)) {
      throw new HttpsError("permission-denied", "Only admins can request event retries")
    }

    const eventId = String((req.data as { eventId?: string })?.eventId || "").trim()
    if (!eventId) {
      throw new HttpsError("invalid-argument", "eventId is required")
    }

    const eventRef = db.doc(`stripe_events/${eventId}`)
    const eventSnap = await eventRef.get()
    if (!eventSnap.exists) {
      throw new HttpsError("not-found", "Event not found")
    }

    const eventData = eventSnap.data() as { processed?: boolean, failed?: boolean } | undefined
    if (eventData?.processed === true && eventData?.failed !== true) {
      throw new HttpsError("failed-precondition", "Event already processed successfully")
    }

    const secret: string | undefined = stripeSecrets.find((entry) => entry.name === "STRIPE_SECRET_KEY")?.value()
    const stripe = getStripe(secret)

    await eventRef.set({
      processed: false,
      failed: false,
      retryRequestedBy: actorUid,
      retryRequestedAt: FieldValue.serverTimestamp(),
      manualRetryRequests: FieldValue.increment(1),
      processingStartedAt: FieldValue.serverTimestamp(),
      lastError: null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })

    try {
      const event = await stripe.events.retrieve(eventId)
      await processStripeEvent(stripe, event)

      await eventRef.set({
        processed: true,
        failed: false,
        processedAt: FieldValue.serverTimestamp(),
        replayedBy: actorUid,
        replayedAt: FieldValue.serverTimestamp(),
        lastError: null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })

      await recordBillingIncident({
        type: "stripe.event.retry_replayed",
        severity: "info",
        eventId,
        eventType: event.type,
        message: `Manual replay succeeded for Stripe event ${eventId}`,
        metadata: {
          actorUid,
        },
      })

      return { ok: true, eventId }
    } catch (error) {
      const errorMessage = toSafeErrorMessage(error)
      await eventRef.set({
        processed: false,
        failed: true,
        failedAt: FieldValue.serverTimestamp(),
        lastError: errorMessage,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })

      await recordBillingIncident({
        type: "stripe.event.retry_failed",
        severity: "error",
        eventId,
        message: `Manual replay failed for Stripe event ${eventId}: ${errorMessage}`,
        metadata: {
          actorUid,
        },
      })

      throw new HttpsError("internal", `Replay failed: ${errorMessage}`)
    }
  },
)

export const expireTrialsToFree = onSchedule(
  {
    schedule: "every 1 hours",
    timeZone: "UTC",
  },
  async () => {
    const nowIso = new Date().toISOString()
    const trialDocs = await db.collectionGroup("billing")
      .where("plan", "==", "trial")
      .get()

    let expiredCount = 0
    for (const trialDoc of trialDocs.docs) {
      const billing = trialDoc.data() as UserBilling
      if (!hasTrialExpired(billing)) {
        continue
      }

      const userRef = trialDoc.ref.parent.parent
      if (!userRef) {
        continue
      }

      await trialDoc.ref.set(buildFreePlanFromExpiredTrial(billing), { merge: true })
      await userRef.set({
        plan: "free",
        status: "inactive",
        subscriptionId: null,
        updated_At: new Date(),
      }, { merge: true })

      expiredCount += 1
    }

    console.log("expireTrialsToFree completed", { checkedAt: nowIso, expiredCount })
  },
)

/**
 * Hourly sweep that downgrades accounts whose payment grace period has expired.
 * When invoice.payment_failed fires, a 3-day graceUntil is set on the billing doc.
 * This function detects graceUntil < now and reverts the account to free/inactive,
 * also voiding the Stripe subscription and recording a billing incident.
 */
export const downgradePastDueAccounts = onSchedule(
  {
    schedule: "every 1 hours",
    timeZone: "UTC",
    // Without this the secret is unbound, getStripe throws, and the catch below turns a
    // broken downgrade into an hourly warning nobody reads. Accounts stay past_due forever.
    secrets: stripeSecrets,
  },
  /**
   * callback
   */
  async () => {
    const now = new Date()
    const nowIso = now.toISOString()

    // Find billing docs with status=past_due and graceUntil < now.
    const pastDueDocs = await db.collectionGroup("billing")
      .where("status", "==", "past_due")
      .get()

    let downgradedCount = 0
    for (const doc of pastDueDocs.docs) {
      const billing = doc.data() as UserBilling
      if (!billing.graceUntil || billing.graceUntil >= nowIso) {
        continue
      }

      const userRef = doc.ref.parent.parent
      if (!userRef) {
        continue
      }

      const uid = userRef.id

      // Cancel the Stripe subscription if one exists.
      if (billing.subscriptionId) {
        try {
          /**
           * callback
           * @param {*} s
           */
          const secret: string | undefined = stripeSecrets.find((s) => s.name === "STRIPE_SECRET_KEY")?.value()
          const stripe = getStripe(secret)
          await stripe.subscriptions.cancel(billing.subscriptionId)
        } catch (error) {
          console.warn(`Failed to cancel Stripe subscription ${billing.subscriptionId}:`, error)
        }
      }

      const downgradedBilling = {
        ...getDefaultBillingForPlan("free"),
        plan: "free" as BillingPlanTier,
        status: "inactive",
        subscriptionId: null,
        planInterval: null as BillingInterval | null,
        cancelAtPeriodEnd: false,
        graceUntil: null,
        updatedAt: FieldValue.serverTimestamp(),
      }

      await Promise.all([
        doc.ref.set(downgradedBilling, { merge: true }),
        userRef.set({
          billing: downgradedBilling,
          plan: "free",
          status: "inactive",
          subscriptionId: null,
          updated_At: new Date(),
        }, { merge: true }),
      ])

      await recordBillingIncident({
        type: "billing.grace_period_expired",
        severity: "error",
        uid,
        message: `Payment grace period ended. Account downgraded from ${billing.plan} to free plan.`,
        metadata: {
          previousPlan: billing.plan,
          previousInterval: billing.planInterval || null,
          graceUntil: billing.graceUntil,
          subscriptionId: billing.subscriptionId,
        },
      })

      downgradedCount += 1
    }

    if (downgradedCount > 0) {
      console.log("downgradePastDueAccounts completed", { checkedAt: nowIso, downgradedCount })
    }
  },
)

/**
 * Daily sweep that expires purchased & included credits past their expiry date.
 * Credits granted with an expiresAt field in the past are deducted from the
 * user's balance and recorded as an "expire" ledger entry for transparency.
 * Configurable via BILLING_CREDIT_EXPIRY_DAYS env var (default: 365 days).
 * Runs every 6 hours.
 */
export const expireStaleCredits = onSchedule(
  {
    schedule: "every 6 hours",
    timeZone: "UTC",
  },
  /**
   * callback
   */
  async () => {
    const now = new Date()
    const nowIso = now.toISOString()

    // Find all credit grant ledger entries that have expired.
    const expiredLedgerSnap = await db.collectionGroup("credits_ledger")
      .where("operation", "==", "grant")
      .where("expiresAt", "<=", nowIso)
      .limit(500)
      .get()

    // Group expired grants by user and bucket, summing the delta.
    const expiryMap = new Map<string, { purchased: number; included: number }>()

    for (const doc of expiredLedgerSnap.docs) {
      const entry = doc.data() as {
        bucket?: string
        delta?: number
        uid?: string
      }

      // Infer uid from the document path: users/{uid}/credits_ledger/{id}
      const pathParts = doc.ref.path.split("/")
      const uid = entry.uid || (pathParts.length >= 3 ? pathParts[1] : null)
      if (!uid) {
        continue
      }

      const bucket = entry.bucket === "included" ? "included" : "purchased"
      const delta = Math.floor(Number(entry.delta || 0))
      if (delta <= 0) {
        continue
      }

      if (!expiryMap.has(uid)) {
        expiryMap.set(uid, { purchased: 0, included: 0 })
      }

      const entryVal = expiryMap.get(uid) as { purchased: number; included: number } | undefined
      if (!entryVal) {
        continue
      }
      entryVal[bucket] += delta
    }

    let expiredCount = 0
    const deletions: Array<Promise<unknown>> = []

    for (const [uid, amounts] of expiryMap) {
      const total = amounts.purchased + amounts.included
      if (total <= 0) {
        continue
      }

      const userRef = db.doc(`users/${uid}`)
      const userSnap = await userRef.get()
      const user = userSnap.data() as Users & { billing?: UserBilling } | undefined
      const billing = user?.billing as UserBilling | undefined

      if (!billing) {
        continue
      }

      // Deduct expired purchased credits via negative mutation.
      if (amounts.purchased > 0) {
        const currentPurchased = Number(billing.credits?.purchasedBalance || 0)
        const nextPurchased = Math.max(0, currentPurchased - amounts.purchased)
        if (nextPurchased < currentPurchased) {
          // Deduct expired purchased credits directly from billing doc.
          const billingRef2 = db.doc(`users/${uid}/billing/current`)
          await billingRef2.set({
            credits: {
              purchasedBalance: nextPurchased,
              purchasedReserved: Math.min(
                Number(billing.credits?.purchasedReserved || 0),
                nextPurchased,
              ),
            },
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true })
        }
      }

      // Deduct expired included credits.
      if (amounts.included > 0) {
        const currentIncluded = Number(billing.credits?.includedBalance || 0)
        const nextIncluded = Math.max(0, currentIncluded - amounts.included)
        if (nextIncluded < currentIncluded) {
          await db.doc(`users/${uid}/billing/current`).set({
            credits: {
              includedBalance: nextIncluded,
              includedReserved: Math.min(
                Number(billing.credits?.includedReserved || 0),
                nextIncluded,
              ),
            },
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true })
        }
      }

      // Mark the original grant ledger entries as expired so they're not re-processed.
      // We update them rather than delete for audit trail.
      /**
       * callback
       * @param {*} d
       * @return {*}
       */
      const userLedgerEntries = expiredLedgerSnap.docs.filter((d) => {
        const pathParts = d.ref.path.split("/")
        const docUid = d.data().uid || (pathParts.length >= 3 ? pathParts[1] : null)
        return docUid === uid
      })

      for (const entryDoc of userLedgerEntries) {
        deletions.push(
          entryDoc.ref.set({ expiredAt: nowIso }, { merge: true }).catch(() => undefined),
        )
      }

      expiredCount += 1
    }

    await Promise.all(deletions)
    console.log("expireStaleCredits completed", { checkedAt: nowIso, expiredUsers: expiredCount })
  },
)

/**
 * Hourly check that every price the catalog can sell is actually sellable in the connected
 * Stripe account.
 *
 * Why this exists: production had no catalog at all - the live account held one unrelated
 * product - and nothing said so. Checkout resolves by lookup_key and falls back to a
 * hardcoded test-mode id when the key misses, so live checkouts were rejected with Stripe's
 * "No such price" and the first person to find out was the customer. `validateStripeCatalog`
 * answers far more than this, but it only runs when an admin remembers to call it, so it
 * cannot be the thing that notices.
 *
 * The incident lands in `billing_incidents`, which the admin bell already lists and
 * acknowledges, so this needs no new collection, UI or alert channel.
 *
 * ponytail: asks only "would a checkout succeed", which is the question that stayed silent.
 * Amount/currency/interval drift stays in the admin-triggered audit.
 */
const CATALOG_INCIDENT_SOURCE = "stripe-catalog-health"
/** Reminder interval while the catalog stays broken. One incident, then at most one a day. */
const CATALOG_INCIDENT_COOLDOWN_MS = 24 * 60 * 60 * 1000

export const checkStripeCatalogHealth = onSchedule(
  {
    schedule: "every 1 hours",
    timeZone: "UTC",
    secrets: stripeSecrets,
  },
  async () => {
    const secret: string | undefined = stripeSecrets.find((secret) => secret.name === "STRIPE_SECRET_KEY")?.value()
    const stripe = getStripe(secret)

    // ponytail: third place that walks the catalog. Extract a shared enumerator when a
    // fourth appears - the two existing callers want different fields off it.
    //
    // Only sellable prices: a zero-amount tier (free, trial, Enterprise PAYG) has no price
    // in any account, so asking Stripe about it reported 9 phantom failures out of 23 and
    // buried the real ones. `validateStripeCatalog` dodges this by filtering on an id;
    // amount is the honest test here, because a sellable price that lost its id is exactly
    // what this check exists to catch.
    const entries = [
      ...billingPlanCatalog.flatMap((plan) =>
        (Object.keys(plan.prices) as BillingInterval[])
          .filter((interval) => plan.prices[interval].amount > 0)
          .map((interval) => ({
            key: lookupKeyForPlan(plan.id, interval),
            fallbackId: plan.prices[interval].stripePriceId,
          })),
      ),
      ...creditPackCatalog.map((pack) => ({
        key: lookupKeyForCredits(pack.credits),
        fallbackId: pack.stripePriceId,
      })),
    ]

    const unusable = await findUnusableCatalogPrices(stripe, entries)
    if (!unusable.length) {
      return
    }

    // One incident, then at most one reminder a day. Keyed on the newest incident from this
    // check whether or not it was acknowledged: an ack means "I know", not "nag me hourly".
    const recent = await db.collection("billing_incidents")
      .orderBy("createdAt", "desc")
      .limit(20)
      .get()
    const lastOwn = recent.docs.find((doc) => {
      const data = doc.data() as { source?: string }
      return data.source === CATALOG_INCIDENT_SOURCE
    })
    const lastOwnMs = lastOwn ? timestampToMillis(lastOwn.data().createdAt) : 0
    if (Date.now() - lastOwnMs < CATALOG_INCIDENT_COOLDOWN_MS) {
      return
    }

    await recordBillingIncident({
      type: "stripe_catalog_incomplete",
      severity: "error",
      source: CATALOG_INCIDENT_SOURCE,
      message: `Checkout cannot resolve ${unusable.length} of ${entries.length} catalog prices. ` +
        "Create them in this Stripe account with the matching lookup_keys, or set the " +
        `corresponding STRIPE_PRICE_* variables. First failures: ${unusable.slice(0, 6).join("; ")}`,
      metadata: {
        unusableCount: unusable.length,
        catalogSize: entries.length,
        unusable: unusable.slice(0, 30),
      },
    })
  },
)

