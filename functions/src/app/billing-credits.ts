/* eslint-disable object-curly-spacing */
/* eslint-disable max-len */
import {FieldValue} from "firebase-admin/firestore"
import {db} from "./config"
import {BillingSnapshot, CreditBucket, getCreditAmounts} from "../domain"

export type BillingCreditOperation =
  "grant" |
  "reserve" |
  "consume" |
  "release" |
  "adjust"

export type BillingCreditMetadata = {
  source: string
  operation: BillingCreditOperation
  reason?: string | null
  grantedBy?: string | null
  sessionId?: string | null
  /**
   * The platform machine a charge was for. Written by the session meter, whose rows
   * are otherwise indistinguishable from each other: every block of every session
   * carries `reason: "meter:block"`, so without this the usage report can say how
   * much browser time cost but not on how many machines it was spent.
   */
  machineId?: string | null
  paymentIntentId?: string | null
  invoiceId?: string | null
  subscriptionId?: string | null
  plan?: string | null
  interval?: string | null
  idempotencyKey?: string | null
  createdAt?: FirebaseFirestore.FieldValue
  /** ISO-8601 date after which these credits expire. Null = never expire. */
  expiresAt?: string | null
  metadata?: Record<string, unknown>
}

export type BillingCreditMutationArgs = {
  uid: string
  bucket: CreditBucket
  balanceDelta?: number
  reservedDelta?: number
  ledger: BillingCreditMetadata
}

export type BillingCreditMutationResult = {
  bucket: CreditBucket
  balance: number
  reserved: number
  available: number
  ledgerId: string
  /**
   * True when the ledger already held this `idempotencyKey`, so nothing was
   * written and the returned balances are the ones already on disk.
   *
   * Callers that COUNT work must read this. The result is truthy either way, so
   * a replay is indistinguishable from a fresh mutation unless it is stated —
   * which made an overlapping sweep count a block twice as spend the customer
   * never incurred, and pushed them past their own cap early.
   */
  replayed?: boolean
}

/**
 * Message fragments produced when a mutation is refused for lack of credits.
 *
 * Both throw sites live in this file, immediately below, and
 * `isInsufficientCreditsError` is the only reader. The refusal is PERMANENT for
 * the current balance: retrying the same mutation without a top-up fails
 * identically, so a caller must stop rather than come back next sweep.
 */
const INSUFFICIENT_CREDITS_PATTERN =
  /would make .* balance negative|would reserve more .* than available/

/**
 * Whether a rejected credit mutation was refused for lack of credits.
 *
 * Distinguishes "the customer cannot pay" from "the write failed this once".
 * The metered sweep reacts to the two differently — the first ends the session,
 * the second retries — so the distinction has to survive as a value rather than
 * be guessed from a truthy result.
 * @param {unknown} error Whatever the mutation threw.
 * @return {boolean} True when the balance, not the network, refused it.
 */
export const isInsufficientCreditsError = (error: unknown): boolean =>
  INSUFFICIENT_CREDITS_PATTERN.test(
    error instanceof Error ? error.message : String(error),
  )

const normalizeWholeNumber = (value: number | undefined): number => {
  const normalized = Math.floor(Number(value || 0))
  return Number.isFinite(normalized) ? normalized : 0
}

const buildLedgerDocId = (raw: string): string =>
  raw.replace(/[\\/#?\]]/g, "_").replace(/\[/g, "_")

const getLedgerRef = (uid: string, idempotencyKey?: string | null) => {
  const collection = db.collection(`users/${uid}/credits_ledger`)
  return idempotencyKey ?
    collection.doc(buildLedgerDocId(idempotencyKey)) :
    collection.doc()
}

const buildCreditsPayload = (
  billing: BillingSnapshot | undefined,
  nextBucket: CreditBucket,
  balance: number,
  reserved: number,
) => {
  const purchased = nextBucket === "purchased" ?
    {balance, reserved} :
    getCreditAmounts(billing, "purchased")
  const included = nextBucket === "included" ?
    {balance, reserved} :
    getCreditAmounts(billing, "included")

  return {
    balance: purchased.balance + included.balance,
    reserved: purchased.reserved + included.reserved,
    purchasedBalance: purchased.balance,
    purchasedReserved: purchased.reserved,
    includedBalance: included.balance,
    includedReserved: included.reserved,
  }
}

export const applyBillingCreditMutation = async (
  args: BillingCreditMutationArgs,
): Promise<BillingCreditMutationResult> => {
  const balanceDelta = normalizeWholeNumber(args.balanceDelta)
  const reservedDelta = normalizeWholeNumber(args.reservedDelta)
  const billingRef = db.doc(`users/${args.uid}/billing/current`)
  const ledgerRef = getLedgerRef(args.uid, args.ledger.idempotencyKey)

  return db.runTransaction(async (transaction) => {
    const [billingSnap, ledgerSnap] = await Promise.all([
      transaction.get(billingRef),
      transaction.get(ledgerRef),
    ])

    const billing = billingSnap.data() as BillingSnapshot | undefined
    const current = getCreditAmounts(billing, args.bucket)

    if (ledgerSnap.exists && args.ledger.idempotencyKey) {
      return {
        bucket: args.bucket,
        balance: current.balance,
        reserved: current.reserved,
        available: Math.max(0, current.balance - current.reserved),
        ledgerId: ledgerRef.id,
        // Stated, not implied. See the field's doc comment: a silent replay is
        // how a re-derived key got counted as fresh spend.
        replayed: true,
      }
    }

    const nextBalance = current.balance + balanceDelta
    const nextReserved = current.reserved + reservedDelta

    if (nextBalance < 0) {
      throw new Error(
        `Billing credit mutation would make ${args.bucket} balance negative`,
      )
    }

    if (nextReserved < 0) {
      throw new Error(
        `Billing credit mutation would make ${args.bucket} reserved credits negative`,
      )
    }

    if (nextReserved > nextBalance) {
      throw new Error(
        `Billing credit mutation would reserve more ${args.bucket} credits than available`,
      )
    }

    transaction.set(billingRef, {
      credits: buildCreditsPayload(
        billing,
        args.bucket,
        nextBalance,
        nextReserved,
      ),
      updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true})

    transaction.set(ledgerRef, {
      source: args.ledger.source,
      operation: args.ledger.operation,
      bucket: args.bucket,
      reason: args.ledger.reason || null,
      grantedBy: args.ledger.grantedBy || null,
      delta: balanceDelta,
      balanceDelta,
      reservedDelta,
      sessionId: args.ledger.sessionId || null,
      paymentIntentId: args.ledger.paymentIntentId || null,
      invoiceId: args.ledger.invoiceId || null,
      subscriptionId: args.ledger.subscriptionId || null,
      plan: args.ledger.plan || null,
      interval: args.ledger.interval || null,
      expiresAt: args.ledger.expiresAt || null,
      metadata: args.ledger.metadata || null,
      idempotencyKey: args.ledger.idempotencyKey || null,
      createdAt: args.ledger.createdAt || FieldValue.serverTimestamp(),
    })

    return {
      bucket: args.bucket,
      balance: nextBalance,
      reserved: nextReserved,
      available: Math.max(0, nextBalance - nextReserved),
      ledgerId: ledgerRef.id,
    }
  })
}

export const grantBillingCredits = async (args: {
  uid: string
  amount: number
  bucket: CreditBucket
  ledger: Omit<BillingCreditMetadata, "operation">
}): Promise<BillingCreditMutationResult | null> => {
  const amount = normalizeWholeNumber(args.amount)
  if (amount <= 0) {
    return null
  }

  return applyBillingCreditMutation({
    uid: args.uid,
    bucket: args.bucket,
    balanceDelta: amount,
    ledger: {
      ...args.ledger,
      operation: "grant",
    },
  })
}

export const reserveBillingCredits = async (args: {
  uid: string
  amount: number
  bucket: CreditBucket
  ledger: Omit<BillingCreditMetadata, "operation">
}): Promise<BillingCreditMutationResult | null> => {
  const amount = normalizeWholeNumber(args.amount)
  if (amount <= 0) {
    return null
  }

  return applyBillingCreditMutation({
    uid: args.uid,
    bucket: args.bucket,
    reservedDelta: amount,
    ledger: {
      ...args.ledger,
      operation: "reserve",
    },
  })
}

export const consumeBillingCredits = async (args: {
  uid: string
  amount: number
  bucket: CreditBucket
  releaseReserved?: boolean
  ledger: Omit<BillingCreditMetadata, "operation">
}): Promise<BillingCreditMutationResult | null> => {
  const amount = normalizeWholeNumber(args.amount)
  if (amount <= 0) {
    return null
  }

  // A replayed key collected nothing, so it must not read as a charge. Returning
  // null is the contract every consumer already handles ("no mutation happened");
  // returning the unchanged balances let the metered sweep count an overlapping
  // run as fresh spend and trip the customer's cap early.
  const applied = await applyBillingCreditMutation({
    uid: args.uid,
    bucket: args.bucket,
    balanceDelta: -amount,
    reservedDelta: args.releaseReserved === false ? 0 : -amount,
    ledger: {
      ...args.ledger,
      operation: "consume",
    },
  })
  return applied.replayed ? null : applied
}

export const releaseBillingCredits = async (args: {
  uid: string
  amount: number
  bucket: CreditBucket
  ledger: Omit<BillingCreditMetadata, "operation">
}): Promise<BillingCreditMutationResult | null> => {
  const amount = normalizeWholeNumber(args.amount)
  if (amount <= 0) {
    return null
  }

  return applyBillingCreditMutation({
    uid: args.uid,
    bucket: args.bucket,
    reservedDelta: -amount,
    ledger: {
      ...args.ledger,
      operation: "release",
    },
  })
}
