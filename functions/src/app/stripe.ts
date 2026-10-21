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
import { applyBillingCreditMutation, grantBillingCredits } from "./billing-credits"
import { paygAccessEndsAt } from "../domain/billing.domain"
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
import { Users, Guest, ANALYTICS_EVENTS, buildAnalyticsEvent, canPurchaseStandaloneCredits, getIncludedCreditsAvailable, getPurchasedCreditsAvailable, toEventHour, toPaidCounterKeys } from "../domain"
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
  /**
   * The intervals this plan can actually be BOUGHT on.
   *
   * Partial because "no self-serve price at this interval" is a real state rather than a
   * missing field: Enterprise is arranged with sales, so it has no `payAsYouGo` price at
   * all. The old shape forced a `buildBillingPriceConfig("enterprise", "payAsYouGo", 0)`
   * entry to keep the type happy, and that placeholder is what the client rendered as a
   * EUR0.00 Enterprise option a customer could click (D5).
   */
  prices: Partial<Record<BillingInterval, BillingPriceConfig>>
  /**
   * Sold by a person, not by a checkout button.
   *
   * The server refuses checkout for these and the client shows "Contact sales" instead of
   * a price. It is a flag on the catalog rather than a check for `id === "enterprise"` in
   * three places, so a second sales-led tier does not need the same condition copying.
   */
  salesLed?: boolean
  /**
   * The tier is provisioned with unmetered usage.
   *
   * Declared here for the catalog and the UI; the ENFORCEMENT is `getBillingAccessMode`
   * returning an access mode that `isChargeableAccessMode` refuses to bill, which is the
   * one place every charging path already asks. A flag that only the UI respected would
   * be a promise, not a product.
   */
  unlimited?: boolean
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

/**
 * The ledger key for a credit grant.
 *
 * One rule per source of truth, ordered from most specific to least: an invoice
 * identifies a billing event, a payment intent a checkout, a session a crawl. A
 * promotional grant has NONE of them — which is why `requestId` exists. Without
 * it the key was null, the ledger document id was random, and one double-click
 * minted the credits twice with nothing to collapse the retry against.
 * @param {object} args Every identifier available for this grant.
 * @return {string | null} The key, or null when nothing at all identifies it.
 */
export const creditsIdempotencyKey = (args: {
  bucket: string
  source: string
  reason?: string | null
  invoiceId?: string | null
  paymentIntentId?: string | null
  sessionId?: string | null
  requestId?: string | null
}): string | null => {
  const label = args.reason || args.source
  if (args.invoiceId) {
    return `invoice:${args.invoiceId}:${args.bucket}:${label}`
  }
  if (args.paymentIntentId) {
    return `payment_intent:${args.paymentIntentId}:${args.bucket}:${label}`
  }
  if (args.sessionId) {
    return `session:${args.sessionId}:${args.bucket}:${label}`
  }
  if (args.requestId) {
    return `request:${args.requestId}:${args.bucket}`
  }
  return null
}

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
  /** Caller-supplied token, for a grant with no Stripe object behind it. */
  requestId?: string
}) => {
  const normalizedDelta = Math.floor(args.delta)
  if (!Number.isFinite(normalizedDelta) || normalizedDelta <= 0) {
    return
  }

  const bucket = args.bucket || "purchased"
  const idempotencyKey = creditsIdempotencyKey({
    bucket,
    source: args.source,
    reason: args.reason,
    invoiceId: args.invoiceId,
    paymentIntentId: args.paymentIntentId,
    sessionId: args.sessionId,
    requestId: args.requestId,
  })

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

/**
 * The subscription an invoice belongs to, whichever API version delivered it.
 *
 * 2023-era versions put it at `invoice.subscription`; the 2025 versions moved it to
 * `invoice.parent.subscription_details.subscription`. The live webhook endpoint pins no
 * API version and so follows the account default, while the test endpoint is pinned to
 * 2023-10-16 — reading a single location made renewal handling depend on which version
 * the account happened to be on, and that divergence stays invisible until money moves.
 *
 * @param {*} invoice Invoice as a webhook event delivered it.
 * @return {*} Subscription id, or null when the invoice carries none.
 */
export const getInvoiceSubscriptionId = (invoice: Stripe.Invoice): string | null => {
  const asId = (value: unknown): string | null => {
    if (typeof value === "string") {
      return value
    }

    if (value && typeof value === "object" && "id" in value) {
      const id = (value as {id?: unknown}).id
      return typeof id === "string" ? id : null
    }

    return null
  }

  const legacyId = asId((invoice as {subscription?: unknown}).subscription)
  if (legacyId) {
    return legacyId
  }

  const parent = (invoice as {
    parent?: {subscription_details?: {subscription?: unknown}} | null
  }).parent

  return asId(parent?.subscription_details?.subscription)
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
// Per-credit price for custom amounts, in EUR minor units. Held level with the
// largest pack rather than at the old EUR0.19, so a custom amount cannot be the
// most expensive way to buy the same credit.
const CUSTOM_CREDIT_UNIT_AMOUNT_EUR = toPositiveInteger(env.BILLING_CUSTOM_CREDIT_UNIT_AMOUNT_EUR, 1)
const BILLING_RESTRICTED_ROLE_KEYWORDS = ["manager", "editor"]
const billingAllowedOrigins = env.IS_PRODUCTION ?
  [
    "https://deepscrape.dev",
    "https://deepscrape.web.app",
    // Widened BEFORE the subdomains carry traffic. Checkout sends
    // `window.location.origin + '/billing/success'`, so an origin missing here makes
    // `assertAllowedReturnUrl` throw permission-denied and billing fails outright the
    // moment the app moves. Listing an origin that does not resolve yet is inert.
    "https://dashboard.deepscrape.dev",
    "https://console.deepscrape.dev",
  ] :
  [
    // The one value that already knows where the app is served. `ng serve` does not
    // always pick 4200 — this repo's dev port is 8080 — and a missing origin makes
    // `assertAllowedReturnUrl` reject checkout outright with "successUrl origin is not
    // allowed", which reads as a permissions bug rather than a config one.
    env.APP_ORIGIN,
    "http://localhost:5000",
    "http://127.0.0.1:5000",
    "http://localhost:4200",
    "http://127.0.0.1:4200",
    // Both spellings of every dev port, so a browser that resolves one and a config that
    // names the other cannot decide whether checkout works.
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://localhost:8081",
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
    ...billingDefaultsForMerge("free"),
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
    // Written explicitly because the admin panel's default query filters on it.
    // A Firestore equality filter EXCLUDES documents that lack the field, so
    // omitting it did not leave incidents "unacknowledged" -- it hid every one
    // of them from the list that exists to surface them, and the ack action had
    // nothing to match against either.
    acknowledged: false,
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
    // Free is not "crawl requests": `bff/api.ts` puts scrape, extract, pdf, serp, search and
    // the schema compiler behind `access` rather than `paid`, and the five monitor routes
    // too. Ten AI vendors are reachable with the caller's own key. Listing three items here
    // undersold the tier and hid why anyone upgrades.
    features: ["extraction_suite", "schema_compiler", "monitors", "ai_providers", "community_support"],
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
    features: ["crawl_api", "extraction_suite", "structured_extraction", "session_reuse", "schema_compiler", "monitors", "ai_providers", "capacity_tools", "browser_session_dedicated", "browser_session_byo", "live_view", "credential_vault", "machine_leasing", "anti_bot", "identity_crawling", "high_concurrency", "proxy_rotation", "priority_support"],
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
    // Starter and Pro carry the SAME tools -- nothing gates a tool by plan, only by `paid`
    // (`PAID_ONLY_TOOLS` in webrain-tools.domain.ts) and by `SESSION_CAPS`, which is per
    // browser tier. So they differ in volume and support, and saying otherwise would invent
    // a difference the platform does not enforce.
    //
    // The last five are engine capabilities, not plan tiers: stealth/anti-bot detection,
    // identity + login automation, batch concurrency, and a rotating proxy pool with
    // geolocation all live in webrain (`detect_antibot`, `stealth_js`, `webrain_login`,
    // `ProxyPool.next_at`), and they reach a caller only through the paid capacity tools.
    features: ["crawl_api", "extraction_suite", "structured_extraction", "session_reuse", "schema_compiler", "monitors", "ai_providers", "capacity_tools", "browser_session_dedicated", "browser_session_byo", "live_view", "credential_vault", "machine_leasing", "anti_bot", "identity_crawling", "high_concurrency", "proxy_rotation"],
    prices: {
      payAsYouGo: buildBillingPriceConfig("starter", "payAsYouGo", 99, env.STRIPE_PRICE_STARTER_PAYG || "price_1UHrhAFVGcR0rD8fVnhA7zv9"),
      monthly: buildBillingPriceConfig("starter", "monthly", 999, env.STRIPE_PRICE_STARTER_MONTHLY || "price_1UHrgtFVGcR0rD8fNsrFs6ul"),
      quarterly: buildBillingPriceConfig("starter", "quarterly", 2799, env.STRIPE_PRICE_STARTER_QUARTERLY || "price_1UHrgtFVGcR0rD8fwmUPSdp2"),
      annually: buildBillingPriceConfig("starter", "annually", 9999, env.STRIPE_PRICE_STARTER_ANNUAL || "price_1UHrgtFVGcR0rD8fhw3hWx5J"),
    },
  },
  {
    id: "pro",
    label: "Pro",
    description: "High-throughput crawling and anti-bot support",
    // Same tools as Starter plus priority support; the real difference is 5x the credits.
    features: ["crawl_api", "extraction_suite", "structured_extraction", "session_reuse", "schema_compiler", "monitors", "ai_providers", "capacity_tools", "browser_session_dedicated", "browser_session_byo", "live_view", "credential_vault", "machine_leasing", "anti_bot", "identity_crawling", "high_concurrency", "proxy_rotation", "priority_support"],
    prices: {
      payAsYouGo: buildBillingPriceConfig("pro", "payAsYouGo", 199, env.STRIPE_PRICE_PRO_PAYG || "price_1UHrhAFVGcR0rD8fuuBT43Nd"),
      monthly: buildBillingPriceConfig("pro", "monthly", 1999, env.STRIPE_PRICE_PRO_MONTHLY || "price_1UHrhAFVGcR0rD8fbNX7Tbdd"),
      quarterly: buildBillingPriceConfig("pro", "quarterly", 5599, env.STRIPE_PRICE_PRO_QUARTERLY || "price_1UHrhAFVGcR0rD8fOntoFTWQ"),
      annually: buildBillingPriceConfig("pro", "annually", 19999, env.STRIPE_PRICE_PRO_ANNUAL || "price_1UHrhAFVGcR0rD8fVC1B257x"),
    },
  },
  {
    id: "enterprise",
    label: "Enterprise",
    description: "Unlimited usage under a custom agreement",
    features: ["unlimited_usage", "crawl_api", "extraction_suite", "structured_extraction", "session_reuse", "capacity_tools", "browser_session_dedicated", "browser_session_byo", "live_view", "credential_vault", "machine_leasing", "anti_bot", "identity_crawling", "high_concurrency", "proxy_rotation", "priority_support", "dedicated_support", "sso", "audit_logs", "custom_limits"],
    // No `payAsYouGo` entry, deliberately. Removing the key IS the fix: a zero-amount
    // config with no price id was still a row the client rendered and a customer could
    // click, and no such price exists in either Stripe account.
    //
    // Why no self-serve pay-as-you-go for this tier at all: enterprise is an annual
    // commitment with support and an SLA, negotiated by a person. Offering a metered
    // option next to it competes with our own sales team -- a procurement group that can
    // buy usage one month at a time will never sign a term contract.
    //
    // The recurring intervals stay listed and priced, because they are the ANCHOR a
    // conversation starts from ("from EUR49.99/month"). `salesLed` is what stops them
    // being a button.
    salesLed: true,
    unlimited: true,
    // The amounts are the published FLOOR of a negotiated deal, not a product: no contract
    // is sold at these numbers, so there is no `stripePriceId` here. Every agreement gets a
    // price created for it, which is also why the three standard Enterprise prices are
    // archived -- an active one is a sellable product that bypasses this refusal entirely
    // (a payment link, a Dashboard invoice, an old marketing URL).
    //
    // Why the floor is EUR99 and not the old EUR49.99: at 49.99 an unlimited account cost
    // us more than it earned. A dedicated machine is ~EUR13/month always-on, and unlimited
    // request-priced work has no ceiling, so the fee has to clear one machine plus a
    // realistic fair-use volume. EUR99 is ~7x the machine cost and ~5x Pro, which is what a
    // step-up tier is supposed to be; quarterly and annual are 6% and 16% off.
    prices: {
      monthly: buildBillingPriceConfig("enterprise", "monthly", 9900),
      quarterly: buildBillingPriceConfig("enterprise", "quarterly", 27900),
      annually: buildBillingPriceConfig("enterprise", "annually", 99900),
    },
  },
]

// Packs are priced so one credit costs at least as much as it does on the
// cheapest SUBSCRIPTION, and no more. Measured cost per credit is about
// EUR0.001 (the worst case is a browser minute at USD0.00031; the average is
// lower), so these are 10-15x cost -- a normal SaaS gross margin -- where the
// previous EUR0.1245-0.19 was 40-190x and 19-48x above our own highest plan
// price. A pack is "no commitment", which justifies a modest premium over a
// plan, not a 76x spread on the same unit.
// Exported for the price-ladder spec: the ratios are the contract, not the amounts.
export const creditPackCatalog: CreditPackCatalog[] = [
  { id: "credits_100", label: "100 credits", credits: 100, amount: 150, currency: "eur", stripePriceId: env.STRIPE_PRICE_CREDITS_100 || "price_1USYnOFVGcR0rD8ftaVb1clf" },
  { id: "credits_500", label: "500 credits", credits: 500, amount: 600, currency: "eur", stripePriceId: env.STRIPE_PRICE_CREDITS_500 || "price_1USYnZFVGcR0rD8f6vkdtUkF" },
  { id: "credits_2000", label: "2000 credits", credits: 2000, amount: 2000, currency: "eur", stripePriceId: env.STRIPE_PRICE_CREDITS_2000 || "price_1USYnZFVGcR0rD8fvGPpkx01" },
]

// Every price above carries a hardcoded TEST-mode price id (account
// acct_1Qag9KFVGcR0rD8f, `livemode: false`, verified against the Stripe API on
// 2026-10-20) when its env var is unset. Stripe ids do not cross modes, so these ids are
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
  // No STRIPE_PRICE_ENTERPRISE_*: Enterprise has no self-serve price to fall back to, so a
  // missing variable there is not a warning worth printing on every cold start.
  "STRIPE_PRICE_CREDITS_100",
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
  // Every token a plan may carry. These are the plan's COMPONENTS, and each one names a
  // capability the code actually grants -- the pricing page renders this list, so a token
  // without a matching rule is an advertisement, and a missing token is a feature the
  // customer paid for and cannot see.
  const allFeatures = [
    "extraction_suite",
    "structured_extraction",
    "session_reuse",
    "schema_compiler",
    "monitors",
    "ai_providers",
    "community_support",
    "crawl_api",
    "capacity_tools",
    "browser_session_dedicated",
    "browser_session_byo",
    "live_view",
    "credential_vault",
    "machine_leasing",
    "anti_bot",
    "identity_crawling",
    "high_concurrency",
    "proxy_rotation",
    "priority_support",
    "dedicated_support",
    "sso",
    "audit_logs",
    "custom_limits",
    "unlimited_usage",
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

/**
 * The same plan defaults, minus the credit map — for every MERGE write.
 *
 * `set(..., { merge: true })` deep-merges nested maps, so spreading the full
 * default into a partial update wrote `purchasedBalance: 0` and
 * `includedBalance: 0` over a customer's real wallet. Every plan transition did
 * that: subscribe, resume, cancel, trial start, trial expiry, and the admin
 * downgrade sweep. A customer who bought 500 credits and then subscribed lost
 * them, and no ledger could reconstruct it.
 *
 * A full default is correct only where the document does not exist yet.
 * @param {BillingPlanTier} plan The plan whose defaults to build.
 * @return {Partial<UserBilling>} Those defaults, without `credits`.
 */
const billingDefaultsForMerge = (plan: BillingPlanTier = "free"): Partial<UserBilling> => {
  const defaults: Partial<UserBilling> = { ...getDefaultBillingForPlan(plan) }
  delete defaults.credits
  return defaults
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
    // Which surface asked. Two entry points share this callable (onboarding and the billing
    // plans page), and a sales queue that cannot tell them apart cannot measure either.
    // An allowlist rather than a free string, so the field stays a small closed vocabulary.
    const source = req.data?.source === "billing_plans" ? "billing_plans" : "service_onboarding"
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
      source,
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
    // A sales-led tier has no pay-as-you-go price at all, and a one-off payment can never
    // be for it rather than for the cheapest plan that happens to share an amount.
    if (!payg) {
      return false
    }

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

/**
 * The Stripe customer to use, or null when this account has never heard of the one on file.
 *
 * A customer id is only meaningful inside the account that minted it, and this project runs
 * the live and sandbox functions against ONE Firestore - so a `stripeId` written while testing
 * in sandbox is not a customer the live key can retrieve. Stripe answers `resource_missing`,
 * and unhandled that surfaced as a 500 on the whole callable: the billing pages, and the
 * checkout that would have replaced the id. Treat it as "no customer yet" - drop the stale
 * field so the next checkout mints one in this account - and let the caller take its
 * no-customer path.
 *
 * @param {*} stripe Initialised Stripe client.
 * @param {*} uid User id, so the stale field can be cleared.
 * @param {*} stripeId The id on the user document, if any.
 * @return {*} A usable customer id, or null.
 */
const resolveStripeCustomerId = async (
  stripe: Stripe,
  uid: string,
  stripeId: string | undefined,
): Promise<string | null> => {
  if (!stripeId) {
    return null
  }

  try {
    const customer = await stripe.customers.retrieve(stripeId)
    return customer.deleted ? null : stripeId
  } catch (error) {
    if ((error as {code?: string} | null)?.code !== "resource_missing") {
      throw error
    }

    console.warn(`[billing] stripeId ${stripeId} is not a customer in this account; clearing it for ${uid}`)
    await db.doc(`users/${uid}`).set({ stripeId: FieldValue.delete() }, { merge: true })
    return null
  }
}

/**
 * The customer id to charge, minting one in the account the current key belongs to.
 *
 * `resolveStripeCustomerId` returns null for a customer minted while the other account was
 * configured - the state of everyone who registered before livemode was switched on.
 * Checkout always answered that by creating a fresh customer; the portal did not, so those
 * users hit a 400 dead end on "add payment method" and could never clear it themselves —
 * the id is only dropped on the way to that same failure. Both paths now resolve-or-mint.
 *
 * @param {*} stripe Initialised Stripe client.
 * @param {*} uid Firebase user id, written as `stripeId` and in both metadata keys.
 * @param {*} user User document, for the email Stripe shows on the customer.
 * @return {*} A customer id this key can actually use.
 */
const ensureStripeCustomerId = async (
  stripe: Stripe,
  uid: string,
  user: Users | undefined,
): Promise<string> => {
  const resolved = await resolveStripeCustomerId(stripe, uid, user?.stripeId)
  if (resolved) {
    return resolved
  }

  const customer = await stripe.customers.create({
    email: user?.email || user?.providerData?.[0]?.email || undefined,
    // `uid` is what the charge, subscription and invoice handlers read; `firebaseUID` is
    // what `customer.updated` reads. Write both so either event resolves the user.
    metadata: { uid, firebaseUID: uid },
  })
  await db.doc(`users/${uid}`).set({ stripeId: customer.id }, { merge: true })
  return customer.id
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
    // `firebaseUID` is what `customer.updated` reads; `uid` is what the charge, subscription
    // and invoice handlers read. Write both so a customer resolves from either event without
    // falling back to a Firestore collection query.
    metadata: { uid: firebaseUser.uid, firebaseUID: firebaseUser.uid },
  })
}


/**
 * A subscription's current billing period, in seconds since the epoch.
 *
 * Stripe's 2025-03-31 API version ("basil") moved the billing period from the
 * subscription onto its items -- "Adds subscription item-level billing periods and
 * removes subscription-level periods". So on any subscription retrieved or delivered
 * under that version, `subscription.current_period_start` and
 * `subscription.current_period_end` are simply absent. This repo's typings are
 * `stripe@17` (2024 acacia), which still declares both fields, so `tsc` cannot warn.
 *
 * Unfixed, this was not a cosmetic null. Four call sites built a date with
 * `new Date(subscription.current_period_start * 1000).toISOString()`, and
 * `new Date(undefined * 1000)` is an Invalid Date whose `toISOString()` THROWS a
 * RangeError. A `trialing` subscription -- or any `customer.subscription.*` event for
 * one -- would have failed inside the handler instead of recording a wrong date.
 *
 * The subscription-level fields are still read when present, because events queued
 * before the endpoint version moved may still carry them. Item first, subscription
 * second, `billing_cycle_anchor` last as the only start the object always has.
 */
type SubscriptionPeriod = {start: number | null; end: number | null}

type SubscriptionPeriodSource = {
  current_period_start?: number | null
  current_period_end?: number | null
  billing_cycle_anchor?: number | null
  items?: {data?: Array<{current_period_start?: number | null; current_period_end?: number | null}>}
}

const asEpochSeconds = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

/**
 * Epoch seconds to an ISO string, or null. Never throws on a missing value.
 * @param {*} seconds Seconds since the epoch, or null.
 * @return {*} The ISO-8601 string, or null.
 */
const toIsoOrNull = (seconds: number | null): string | null =>
  seconds === null ? null : new Date(seconds * 1000).toISOString()

/**
 * Read the billing period from an item first, then the subscription, then the anchor.
 * @param {unknown} subscription A Stripe subscription, whatever version shaped it.
 * @return {SubscriptionPeriod} Start and end in epoch seconds, either may be null.
 */
export const getSubscriptionPeriod = (subscription: unknown): SubscriptionPeriod => {
  const source = (subscription || null) as SubscriptionPeriodSource | null
  const item = source?.items?.data?.[0]

  return {
    start: asEpochSeconds(item?.current_period_start) ?? asEpochSeconds(source?.current_period_start) ?? asEpochSeconds(source?.billing_cycle_anchor),
    end: asEpochSeconds(item?.current_period_end) ?? asEpochSeconds(source?.current_period_end),
  }
}

  const getSubscriptionCycleFields = (subscription: Stripe.Subscription): Partial<UserBilling> => {
    const period = getSubscriptionPeriod(subscription)

    return {
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      cancelAt: toIsoOrNull(asEpochSeconds(subscription.cancel_at)),
      currentPeriodStart: toIsoOrNull(period.start),
      currentPeriodEnd: toIsoOrNull(period.end),
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
        (Object.keys(plan.prices) as BillingInterval[]).flatMap((interval) => {
          const price = plan.prices[interval]
          // Only intervals the plan actually lists. A missing `payAsYouGo` is a tier that
          // is not sold that way, not a price that lost its id.
          if (!price?.stripePriceId) {
            return []
          }

          return [{
            id: price.stripePriceId,
            lookupKey: lookupKeyForPlan(plan.id, interval),
            type: "plan" as const,
            ref: `${plan.id}:${interval}`,
            expectedAmount: price.amount,
            expectedCurrency: price.currency,
            expectedRecurring: interval !== "payAsYouGo",
            expectedMonths: interval === "payAsYouGo" ? null : expectedPlanMonths[interval],
          }]
        }),
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
        ...billingDefaultsForMerge("free"),
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
              trialStartedAt: toIsoOrNull(getSubscriptionPeriod(latestActiveRecurring).start),
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
            ...billingDefaultsForMerge(inferredPlan),
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
      ...billingDefaultsForMerge("trial"),
      // The 160 trial credits are granted HERE, explicitly. The merge no longer
      // inherits the default credit map — that inheritance is what used to zero a
      // customer's purchased balance — so the grant and the preservation are both
      // stated. A free user holding bought credits keeps them through a trial.
      credits: {
        ...getDefaultBillingForPlan("trial").credits,
        purchasedBalance: billing?.credits?.purchasedBalance || 0,
        purchasedReserved: billing?.credits?.purchasedReserved || 0,
      },
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

// ponytail: the period's ledger rows are read newest-first and capped. Hitting the cap
// still truncates a very heavy user's period, but it now drops the OLDEST rows of that
// period instead of an arbitrary document-id slice of all time. Paginate if a ledger ever
// approaches this.
const USAGE_LEDGER_SCAN_LIMIT = 500

/** One row from `users/{uid}/credits_ledger`, as the report reads it. */
export type MeteredConsumeRow = {
  operation?: string | null
  delta?: number
  reason?: string | null
  source?: string | null
  machineId?: string | null
  createdAt?: { toMillis?: () => number }
}

/** A capability's share of the period, keyed by the action the pricing policy charged. */
export type MeteredUsageTotal = {
  key: string
  credits: number
  events: number
  /**
   * How many DISTINCT machines those events came from.
   *
   * Only the session meter writes `machineId`, so a capability charged per request
   * reports 0 rather than a misleading 1. It exists because `meter:block` is the
   * same reason on every block of every session: without a distinct count the
   * report could say browser time cost 47 credits but not whether that was one
   * long lease or six short ones. Rows written before the field existed also count
   * 0, which is why it is reported rather than rendered as a hard number.
   */
  machines: number
}

/**
 * Totals, and a per-capability breakdown, from one pass over the consume ledger.
 *
 * The ledger already records why a credit was taken — `reason` is the pricing policy's own
 * action name, written at charge time — so "what did I actually pay for" needs no second
 * collection and no second query. `source` is the fallback for rows written before `reason`
 * existed, and a row with neither still contributes to the total under `unknown` rather than
 * being dropped: a total that disagrees with the sum of its parts is worse than an unnamed
 * bucket.
 *
 * Pure and exported so the spec can pin the window, the grouping and the ordering without a
 * callable or a Firestore emulator.
 *
 * @param {*} rows Ledger rows for this user, in any order. Rows whose
 *   `operation` is present and is not `consume` are skipped: the report's read
 *   is bounded by `createdAt` alone, so a period's grants and reservations
 *   arrive alongside its consumes, and a grant's positive delta would otherwise
 *   be reported as spend. A row with no `operation` predates the field and is
 *   still counted.
 * @param {*} window Inclusive bounds of the reporting period.
 * @return {*} Credits in range, plus the breakdown sorted by credits descending.
 */
export const summarizeMeteredConsumes = (
  rows: MeteredConsumeRow[],
  window: {startMs: number, endMs: number},
): {creditsUsed: number, metered: MeteredUsageTotal[]} => {
  const totals = new Map<string, MeteredUsageTotal>()
  const machinesByKey = new Map<string, Set<string>>()
  let creditsUsed = 0

  for (const row of rows) {
    if (row.operation && row.operation !== "consume") {
      continue
    }

    const at = row.createdAt?.toMillis?.() || 0
    if (at < window.startMs || at > window.endMs) {
      continue
    }

    const credits = Math.abs(Number(row.delta || 0))
    creditsUsed += credits
    if (credits <= 0) {
      continue
    }

    const key = (row.reason || row.source || "unknown").trim() || "unknown"
    const current = totals.get(key) || {key, credits: 0, events: 0, machines: 0}
    current.credits += credits
    current.events += 1
    totals.set(key, current)

    const machineId = typeof row.machineId === "string" ? row.machineId.trim() : ""
    if (machineId) {
      const seen = machinesByKey.get(key) || new Set<string>()
      seen.add(machineId)
      machinesByKey.set(key, seen)
      current.machines = seen.size
    }
  }

  const metered = [...totals.values()].sort((a, b) => b.credits - a.credits)
  return {creditsUsed, metered}
}

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

    const secret: string | undefined = stripeSecrets.find((entry) => entry.name === "STRIPE_SECRET_KEY")?.value()
    const stripe = getStripe(secret)
    // A customer from the other mode is not retrievable here, so this clears it rather than
    // letting Stripe's resource_missing fail the whole call.
    const stripeCustomerId = await resolveStripeCustomerId(stripe, userId, user?.stripeId)

    // The only part of this page that is not money. `currentUsage` is the counter the
    // `projects/{projectId}` trigger increments and the credits ledger records what was
    // actually consumed; Stripe knows neither number, which is why the meter chart that used
    // to sit below could never fill itself.
    //
    // Bounded to the reporting window and read newest-first. Without an `orderBy`, `limit`
    // returns an arbitrary document-id slice of the WHOLE ledger, so a heavy user's period
    // could come back empty. `createdAt` is the only field this query filters, so its
    // automatic single-field index serves it; adding the `operation` equality alongside the
    // range would need a composite index this project does not declare, so
    // `summarizeMeteredConsumes` drops the non-consume rows instead.
    const consumeLedger = await db.collection(`users/${userId}/credits_ledger`)
      .where("createdAt", ">=", new Date(window.startMs))
      .where("createdAt", "<=", new Date(window.endMs))
      .orderBy("createdAt", "desc")
      .limit(USAGE_LEDGER_SCAN_LIMIT)
      .get()
    const consumeRows = consumeLedger.docs.map((entry) => entry.data() as MeteredConsumeRow)
    const {creditsUsed: creditsUsedInRange, metered} = summarizeMeteredConsumes(consumeRows, window)

    const creditsSnap = await db.doc(`users/${userId}/billing/current`).get()
    const credits = creditsSnap.data() as UserBilling | undefined
    const usage = {
      currentUsage: Number(user?.currentUsage || 0),
      usageCap: Number(usageCapsByPlan[mapPlanIdToTier(user?.plan || "free")] || 0),
      includedCredits: getIncludedCreditsAvailable(credits),
      purchasedCredits: getPurchasedCreditsAvailable(credits),
      creditsUsedInRange,
      metered,
    }

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
      },
      usage,
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
        source: "invoice_line" | "payment"
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

    const [invoiceList, paymentIntentList] = await Promise.all([
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

    const breakdown = [
      ...breakdownFromInvoices,
      ...breakdownFromPayments,
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

    const totalInvoiced = invoiceRows.reduce((acc, row) => acc + row.total, 0)
    const totalPaid = invoiceRows.reduce((acc, row) => acc + row.amountPaid, 0)

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
      },
      usage,
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
      customCredits,
      checkoutRequestId,
    } = req.data as {
      planId: string
      interval?: BillingInterval
      successUrl: string
      cancelUrl: string
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

    // Resolves the stored id, or mints a customer in the account this key actually owns. A
    // sandbox-era id is not retrievable with the live key, so it is dropped and replaced here.
    const customerId = await ensureStripeCustomerId(stripe, userId, user)

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

    // A sales-led tier is refused HERE, not merely hidden in the UI. The client cannot start
    // this checkout and neither can a crafted call: hiding a button is not a policy.
    if (selectedPlan?.salesLed) {
      throw new HttpsError(
        "failed-precondition",
        `${selectedPlan.label} is arranged with our sales team. Contact sales to set it up.`,
      )
    }

    // The interval the plan does not sell. Enterprise lost `payAsYouGo` in this change, and
    // without this check the request would fall through to "Stripe price id is missing",
    // which tells an operator nothing about what they actually asked for.
    if (selectedPlan && !selectedPlanPrice) {
      throw new HttpsError(
        "failed-precondition",
        `${selectedPlan.label} is not sold on the ${interval} interval`,
      )
    }

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
      // Always one. The webhook credits `pack.credits` exactly once, and both the
      // refund reversal and the metadata assume a single pack — so honouring a
      // caller-supplied `quantity` charged 3x the price and still granted 1x.
      quantity: 1,
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
      idempotencyKey: `checkout_${userId}_${planId}_${interval}_${isCustomCredits ? normalizedCustomCredits : 1}_${normalizedCheckoutRequestId}`,
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
    // No dead end: a customer minted under the previously-configured account is not retrievable
    // here, so resolve-or-mint instead of throwing - "add payment method" must still open the
    // portal for every account that registered before livemode was switched on.
    const customerId = await ensureStripeCustomerId(stripe, userId, user)

    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
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

    let updatedSubscription: Stripe.Subscription
    try {
      updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: false,
      })
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== "resource_missing") throw error
      // Same failure class as the stored customer id: an id minted under the other
      // Stripe account (test vs live) is meaningless to the current key. Clear it so
      // the UI stops offering "resume" and the caller gets a clean error, not a 500.
      console.warn(`[billing] subscription ${subscriptionId} does not exist in this account; clearing it for ${userId}`)
      await userRef.set({ "subscriptionId": FieldValue.delete(), "billing.subscriptionId": null }, { merge: true })
      throw new HttpsError("failed-precondition", "This subscription no longer exists for this account. Please choose a plan to continue.")
    }

    const recurringPrice = updatedSubscription.items.data[0]?.price
    const recurringMatch = inferRecurringPlanFromPriceId(recurringPrice?.id, recurringPrice?.lookup_key)
    const currentPlan = billing?.plan || mapPlanIdToTier(user?.plan || "free")
    const effectivePlan: BillingPlanTier = updatedSubscription.status === "trialing" ?
     "trial" : (recurringMatch?.plan || currentPlan)

    const updatedBilling = {
      ...billingDefaultsForMerge(effectivePlan),
      plan: effectivePlan,
      planInterval: recurringMatch?.interval || billing?.planInterval || null,
      status: updatedSubscription.status,
      subscriptionId: updatedSubscription.id,
      features: getFeaturesFromPlan(effectivePlan),
      ...getSubscriptionCycleFields(updatedSubscription),
      ...(updatedSubscription.status === "trialing" ? {
        trialPlanTarget: recurringMatch?.plan || billing?.trialPlanTarget || "pro",
        trialStartedAt: billing?.trialStartedAt || toIsoOrNull(getSubscriptionPeriod(updatedSubscription).start),
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

/**
 * Credits to claw back for a refund, pure so the spec can pin it.
 *
 * Only credit-pack and custom-credit charges granted *purchased* credits; subscription
 * charges granted included credits that renew on the next invoice, so they are not reversed
 * here. Pro-rata by refunded amount and clamped to what is actually left: reversing a spent
 * balance would drive the ledger negative, which `applyBillingCreditMutation` rejects, and a
 * rejected mutation fails the webhook for Stripe to retry forever.
 *
 * ponytail: pro-rata on money, not FIFO over ledger rows. Exact lot accounting needs a refund
 * tied to the grant it reverses - worth it only if partial refunds of mixed packs get common.
 *
 * @param {*} charge Charge as the webhook delivered it.
 * @param {*} packCredits Credits that charge originally granted.
 * @param {*} availablePurchased Purchased credits the customer can still use.
 * @return {*} Whole credits to reverse, never negative, never more than available.
 */
export const computeRefundCreditReversal = (
  charge: Pick<Stripe.Charge, "amount" | "amount_refunded">,
  packCredits: number,
  availablePurchased: number,
): number => {
  const amount = Number(charge.amount || 0)
  const refunded = Number(charge.amount_refunded || 0)
  if (amount <= 0 || refunded <= 0 || packCredits <= 0) {
    return 0
  }

  const granted = Math.floor(packCredits * Math.min(1, refunded / amount))
  return Math.max(0, Math.min(granted, availablePurchased))
}

const processStripeEvent = async (stripe: Stripe, event: Stripe.Event): Promise<void> => {
  switch (event.type) {
  case "checkout.session.completed":
  // A delayed-notification method (SEPA/ACH/BNPL) completes first and pays days
  // later, so the grant has to be reachable from BOTH events. It is idempotent on
  // the session id, so an account charged by card at completion cannot be credited
  // twice.
  // falls through
  case "checkout.session.async_payment_succeeded": {
    const session = event.data.object as Stripe.Checkout.Session
    const uid = session.metadata?.uid || session.client_reference_id
    if (!uid) {
      break
    }

    // `completed` fires with `payment_status: "unpaid"` for those methods. Granting
    // there minted credits before the money cleared, and `async_payment_failed`
    // fell into `default:` and was ignored — free credits, repeatably.
    if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
      break
    }

    const protectedUserSnap = await db.doc(`users/${uid}`).get()
    const protectedUser = protectedUserSnap.data() as Users | undefined
    if (isBillingRestrictedUser(protectedUser)) {
      const restrictedSessionBilling = {
        ...billingDefaultsForMerge("free"),
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
            trialStartedAt: toIsoOrNull(getSubscriptionPeriod(subscription).start),
            trialEndsAt: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
            trialUsedAt: new Date().toISOString(),
            trialCreditCapEur: TRIAL_DEFAULT_CREDIT_CAP_EUR,
          }
        }
      }

      const checkoutBilling = {
        ...billingDefaultsForMerge(effectivePlan),
        status: effectiveStatus,
        subscriptionId: effectiveSubscriptionId,
        planInterval: selectedInterval,
        ...subscriptionMeta,
        ...trialMeta,
        // A `payAsYouGo` payment is one-off, so Stripe sends no period for it and
        // no subscription will ever lapse it. Writing the window HERE is what
        // makes `isPaygWindowClosed` able to answer; without it the plan was
        // granted permanently for a tenth of the monthly price, repeatably.
        ...(checkoutType === "plan_payg" ? {currentPeriodEnd: paygAccessEndsAt(Date.now())} : {}),
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

    const subscriptionId = getInvoiceSubscriptionId(invoice) || billing?.subscriptionId || null
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
      ...billingDefaultsForMerge(inferredPlan),
      plan: inferredPlan,
      planInterval: "payAsYouGo" as BillingInterval,
      status: "active",
      cancelAtPeriodEnd: false,
      cancelAt: null,
      currentPeriodStart: null,
      // The same window the checkout path writes. This legacy branch (a payment
      // carrying no `checkoutType`) previously wrote `null` and left the plan
      // permanent, which is the defect the field exists to close.
      currentPeriodEnd: paygAccessEndsAt(Date.now()),
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
        trialStartedAt: toIsoOrNull(getSubscriptionPeriod(subscription).start),
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
      ...billingDefaultsForMerge("free"),
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
    // `dispute.charge` arrives as an id in a webhook, so this used to hand a *charge* id to a
    // lookup that matches on `users.stripeId`: it never matched, the guard below dropped the
    // event, and disputes were recorded nowhere. Retrieve the charge (disputes are rare, one
    // call) and read the uid off its metadata, which Checkout copies from the PaymentIntent.
    const disputeCharge = typeof dispute.charge === "string" ?
      await stripe.charges.retrieve(dispute.charge) :
      dispute.charge as Stripe.Charge | null
    const disputeUid = dispute.metadata?.uid ||
      disputeCharge?.metadata?.uid ||
      await resolveUidByStripeCustomer(disputeCharge?.customer)
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

    // Take back the purchased credits this charge granted. Keyed on the cumulative refunded
    // amount, so each partial refund reverses exactly once and a replay of the same event
    // reverses nothing - the ledger's own idempotency check decides.
    const checkoutType = charge.metadata?.checkoutType
    const packCredits = checkoutType === "custom_credits" ?
      Math.floor(Number(charge.metadata?.customCredits || 0)) :
      checkoutType === "credits" ?
        creditPackCatalog.find((item) => item.id === charge.metadata?.planId)?.credits || 0 :
        0
    const refundBillingSnap = await db.doc(`users/${refundUid}/billing/current`).get()
    const refundReversal = computeRefundCreditReversal(
      charge,
      packCredits,
      getPurchasedCreditsAvailable(refundBillingSnap.data() as UserBilling | undefined),
    )
    if (refundReversal > 0) {
      await applyBillingCreditMutation({
        uid: refundUid,
        bucket: "purchased",
        balanceDelta: -refundReversal,
        ledger: {
          source: "stripe_refund",
          operation: "adjust",
          reason: "refund_reversal",
          // Keyed on the CHARGE, not the cumulative refunded amount. The amount
          // version minted a new key for every partial refund while the arithmetic
          // stayed cumulative (`floor(pack * refunded / amount)`), so a second €5
          // refund on a €20 pack reversed 1000 credits where 500 was right — 1500
          // clawed back for 1000. Never over-debiting is the platform's rule.
          // shortcut: one reversal per charge, so a chain of partial refunds
          // under-recovers. Upgrade to lot accounting (a state doc holding the
          // reversed total, read and written in one transaction) if partial refunds
          // of the same charge become common.
          idempotencyKey: `refund:${charge.id}`,
          metadata: {chargeId: charge.id, amountRefunded: refundedAmount, credits: refundReversal},
        },
      })
    }
    break
  }
  // The network (card account updater) or the PaymentMethod update API can change the brand,
  // last4 and expiry of an already-attached card without detaching it, so the mirror below has
  // to re-merge on those events too or /billing/paymentmethods shows a stale expiry.
  case "payment_method.attached":
  case "payment_method.updated":
  case "payment_method.automatically_updated": {
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
      // only the first sighting stamps the add time; an update must not move it
      ...(event.type === "payment_method.attached" ?
       { createdAt: FieldValue.serverTimestamp() } : {}),
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
  case "customer.updated": {
    const customer = event.data.object as Stripe.Customer
    const custUid = customer.metadata?.uid || customer.metadata?.firebaseUID ||
      await resolveUidByStripeCustomer(customer.id)
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

    const upcomingSubscriptionId = getInvoiceSubscriptionId(upcoming)
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

// How long one delivery owns an event record. Long enough to cover a slow handler, short
// enough that a retry after a crash is not blocked. Stored as a number, not a Timestamp, so
// the comparison below needs no conversion.
const STRIPE_EVENT_LEASE_MS = 5 * 60 * 1000

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
    // Stripe can redeliver an event while the first delivery is still running, and without a
    // claim both would apply it. The lease lets exactly one through: the loser answers 200 so
    // Stripe stops retrying, and the winner is already applying it. The lease expires, so a
    // genuine retry after a crash still proceeds.
    const leaseUntilMs = Date.now() + STRIPE_EVENT_LEASE_MS
    try {
      await eventRef.create({
        type: event.type,
        // Both functions write to this collection and event ids are unique per mode, so
        // without this a failed sandbox delivery reads as a failed live one in the panel.
        livemode: event.livemode,
        processed: false,
        failed: false,
        retryCount: 0,
        leaseUntilMs,
        processingStartedAt: FieldValue.serverTimestamp(),
      })
    } catch {
      const existingEvent = await eventRef.get()
      const existingData = existingEvent.data() as { processed?: boolean, leaseUntilMs?: number } | undefined
      if (existingData?.processed === true) {
        res.status(200).send("Already processed")
        return
      }

      if ((existingData?.leaseUntilMs || 0) > Date.now()) {
        res.status(200).send("Already in progress")
        return
      }

      await eventRef.set({
        failed: false,
        lastRetryAt: FieldValue.serverTimestamp(),
        retryCount: FieldValue.increment(1),
        leaseUntilMs,
        processingStartedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
    }

    try {
      await processStripeEvent(stripe, event)

      await eventRef.set({
        type: event.type,
        processed: true,
        failed: false,
        leaseUntilMs: 0,
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
        // Released so Stripe's own retry (or the admin replay) is not locked out.
        leaseUntilMs: 0,
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
    const project = snap.data() as { userId?: string }
    const userId = project?.userId
    if (!userId) {
      return
    }

    const userRef = db.doc(`users/${userId}`)

    const userDoc = await userRef.get()
    const user = userDoc.data()

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

// A fat-fingered extra zero was otherwise unbounded: the ledger records it, and
// nothing refused it.
const MAX_PROMOTIONAL_CREDITS = 100000

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

    const { targetUserId, credits, reason = "promotional_credit", requestId } = req.data as {
      targetUserId: string
      credits: number
      reason?: string
      requestId: string
    }

    const normalizedTargetUserId = String(targetUserId || "").trim()
    const normalizedReason = String(reason || "").trim() || "promotional_credit"
    const normalizedRequestId = String(requestId || "").trim()

    if (!normalizedTargetUserId || !Number.isFinite(credits) || credits <= 0) {
      throw new HttpsError("invalid-argument", "targetUserId and positive credits are required")
    }

    // Mandatory, not optional: a promotional grant has no invoice, payment intent
    // or session to key on, so without a caller token the ledger document id is
    // random and the same click mints again on every retry.
    if (!normalizedRequestId) {
      throw new HttpsError("invalid-argument", "requestId is required so a retried grant cannot mint twice")
    }

    const normalizedCredits = Math.floor(credits)
    if (normalizedCredits > MAX_PROMOTIONAL_CREDITS) {
      throw new HttpsError("invalid-argument", `A single grant is limited to ${MAX_PROMOTIONAL_CREDITS} credits`)
    }

    await addCreditsLedgerEntry({
      uid: normalizedTargetUserId,
      delta: normalizedCredits,
      source: "promotional_credit",
      bucket: "purchased",
      grantedBy: actorUid,
      reason: normalizedReason,
      requestId: normalizedRequestId,
    })

    await db.collection("audit_logs").add({
      action: "admin_grant_promotional_credits",
      admin_uid: actorUid,
      target_userId: normalizedTargetUserId,
      credits: normalizedCredits,
      reason: normalizedReason,
      // Correlates the audit row with the ledger row the key produced, so a
      // suspicious grant can be traced both ways.
      requestId: normalizedRequestId,
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

    const eventData = eventSnap.data() as { processed?: boolean, failed?: boolean, leaseUntilMs?: number } | undefined
    if (eventData?.processed === true && eventData?.failed !== true) {
      throw new HttpsError("failed-precondition", "Event already processed successfully")
    }

    // The handler that owns this event is still running, so replaying it now would apply it
    // twice. No lease is taken here: a manual replay is one operator, and if it fails the
    // failure path clears nothing, so there is no lease to strand.
    if ((eventData?.leaseUntilMs || 0) > Date.now()) {
      throw new HttpsError("failed-precondition", "Event is being processed right now")
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
        ...billingDefaultsForMerge("free"),
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
    //
    // `expiresAt > ""` is load-bearing, not decoration. Every ledger row is
    // written with `expiresAt: <null>` when the caller sets no expiry
    // (`billing-credits.ts`), and Firestore sorts null BELOW every string — so
    // the `<=` alone matched every grant ever written and this job deducted the
    // sum of all of them from each wallet. The second inequality turns the two
    // into the range `("", nowIso]`, which cannot contain null.
    const expiredLedgerSnap = await db.collectionGroup("credits_ledger")
      .where("operation", "==", "grant")
      .where("expiresAt", "<=", nowIso)
      .where("expiresAt", ">", "")
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
        // Clearing `expiresAt` IS the idempotency. Writing only `expiredAt` left the
        // row matching `expiresAt <= now` on every later run, so the same credits
        // were deducted again six hours later — for ever.
        deletions.push(
          entryDoc.ref.set({ expiredAt: nowIso, expiresAt: null }, { merge: true }).catch(() => undefined),
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
      ...billingPlanCatalog.flatMap((plan) => {
        // A sales-led tier is not sold by price id, so asking Stripe about its lookup keys
        // would report a failure every hour for a tier that is working exactly as intended.
        if (plan.salesLed) {
          return []
        }

        return (Object.keys(plan.prices) as BillingInterval[]).flatMap((interval) => {
          const price = plan.prices[interval]
          if (!price || price.amount <= 0) {
            return []
          }

          return [{key: lookupKeyForPlan(plan.id, interval), fallbackId: price.stripePriceId}]
        })
      }),
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

