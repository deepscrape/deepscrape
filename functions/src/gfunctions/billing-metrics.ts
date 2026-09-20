/* eslint-disable max-len */
/**
 * Nightly billing snapshot for the admin analytics.
 *
 * Why a snapshot instead of deltas on the Stripe webhook: Stripe retries
 * deliveries, so an increment-based MRR drifts on a duplicate event unless every
 * event carries its own idempotency marker. Reading the stored state cannot
 * drift, and the row count is just the paying base.
 *
 * ponytail: full scan of paying accounts each night. Move to delta counters on
 * `customer.subscription.*` if that base outgrows a few thousand accounts.
 */
import {onSchedule} from "firebase-functions/v2/scheduler"
import {Timestamp} from "firebase-admin/firestore"
import {db} from "../app/config"
import {billingPlanCatalog} from "../app/stripe"
import {
  BillingAccountRow,
  BillingInterval,
  BillingPlanTier,
  computeBillingMetrics,
} from "../domain"

/** Plans that represent a paying or trialing account. */
const BILLING_METRIC_PLANS = ["trial", "starter", "pro", "enterprise"]

/**
 * List price for a plan/interval pair, in EUR minor units.
 *
 * @param {BillingPlanTier} plan Billing tier.
 * @param {BillingInterval} interval Billed interval.
 * @return {number} Amount in minor units, or 0 when the pair has no recurring price.
 */
const priceForPlan = (plan: BillingPlanTier, interval: BillingInterval): number =>
  billingPlanCatalog.find((entry) => entry.id === plan)?.prices?.[interval]?.amount ?? 0

/**
 * Read the stored billing state of every paying or trialing account.
 *
 * @return {Promise<BillingAccountRow[]>} One row per account, ready for the aggregator.
 */
const loadBillingRows = async (): Promise<BillingAccountRow[]> => {
  const snapshot = await db.collection("users")
    .where("plan", "in", BILLING_METRIC_PLANS)
    .select("plan", "status", "billing")
    .get()

  return snapshot.docs.map((doc) => {
    const data = doc.data() as {
      plan?: string | null
      status?: string | null
      billing?: BillingAccountRow | null
    }
    // The webhook mirrors plan/status onto the user document; `billing` is the
    // fuller record (interval, trial target), so it wins where present.
    const billing = data.billing || {}

    return {
      plan: billing.plan || data.plan || null,
      planInterval: billing.planInterval || null,
      status: billing.status || data.status || null,
      trialEndsAt: billing.trialEndsAt || null,
      trialPlanTarget: billing.trialPlanTarget || null,
    }
  })
}

/**
 * Snapshot MRR, plan mix, active trials and payment risk once a day.
 *
 * Absolute values, not increments: re-running the job overwrites rather than
 * double-counts. `metrics_billing/current` is what the admin panel reads, the
 * dated documents are the trend.
 *
 * @return {Promise<void>} Resolves once the snapshot is committed, or the failure is logged.
 */
export const computeBillingMetricsDaily = onSchedule("15 0 * * *", async () => {
  try {
    const rows = await loadBillingRows()
    const metrics = computeBillingMetrics(rows, priceForPlan, Date.now())
    const date = new Date().toISOString().split("T")[0]

    if (metrics.payingAccounts > 0 && metrics.mrrEurMinor === 0) {
      console.warn(
        "billing-metrics: paying accounts found but MRR is 0 -- check `billing.planInterval` on the user documents.",
      )
    }

    const payload = {
      ...metrics,
      mrrEur: Math.round(metrics.mrrEurMinor) / 100,
      trialPipelineEur: Math.round(metrics.trialPipelineEurMinor) / 100,
      computedAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    }

    const batch = db.batch()
    batch.set(db.doc("metrics_billing/current"), payload, {merge: true})
    batch.set(db.doc(`metrics_billing/${date}`), payload, {merge: true})
    await batch.commit()

    console.log(
      `✅ Billing metrics: ${payload.mrrEur} EUR MRR, ${metrics.payingAccounts} paying, ` +
      `${metrics.activeTrials} active trials, ${metrics.pastDueAccounts} past due`,
    )
  } catch (error) {
    console.error("❌ Billing metrics snapshot failed:", error)
  }
})
