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
  /**
   * The organization whose wallet this mutation touches, when there is one.
   *
   * Absent means the caller's own wallet, which is every path that existed before
   * organizations could hold credits. Present redirects BOTH the balance document
   * and the ledger to `orgs/{orgId}/...` — the member's uid is still the identity
   * that spent, it is simply no longer the account that pays.
   */
  orgId?: string
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

const getLedgerRef = (
  uid: string,
  idempotencyKey?: string | null,
  orgId?: string,
) => {
  const collection = db.collection(ledgerCollectionPath(uid, orgId))
  return idempotencyKey ?
    collection.doc(buildLedgerDocId(idempotencyKey)) :
    collection.doc()
}

/**
 * The ledger collection a credit operation belongs to.
 *
 * Two namespaces, never one: an org wallet lives at `orgs/{orgId}` and a person's
 * at `users/{uid}`. Writing an org's credits under `users/{orgId}` would collide
 * with a real user id and be owner-scoped by the rules, so no member could read
 * the wallet they are paying from.
 * @param {string} uid The member's uid.
 * @param {string} [orgId] The organization, when the account is the org's.
 * @return {string} The collection path.
 */
export const ledgerCollectionPath = (uid: string, orgId?: string): string =>
  orgId ? `orgs/${orgId}/credits_ledger` : `users/${uid}/credits_ledger`

/**
 * The credit balance document for the same two namespaces.
 * @param {string} uid The member's uid.
 * @param {string} [orgId] The organization, when the account is the org's.
 * @return {string} The document path.
 */
export const billingDocPath = (uid: string, orgId?: string): string =>
  orgId ? `orgs/${orgId}/billing/current` : `users/${uid}/billing/current`

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
  const billingRef = db.doc(billingDocPath(args.uid, args.orgId))
  const ledgerRef = getLedgerRef(args.uid, args.ledger.idempotencyKey, args.orgId)

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
  /** The organization paying, when one is. Absent means the caller's own wallet. */
  orgId?: string
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
    orgId: args.orgId,
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
  /** The organization paying, when one is. Absent means the caller's own wallet. */
  orgId?: string
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
    orgId: args.orgId,
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
  /** The organization paying, when one is. Absent means the caller's own wallet. */
  orgId?: string
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
    orgId: args.orgId,
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
  /** The organization paying, when one is. Absent means the caller's own wallet. */
  orgId?: string
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
    orgId: args.orgId,
    bucket: args.bucket,
    reservedDelta: -amount,
    ledger: {
      ...args.ledger,
      operation: "release",
    },
  })
}

/** Whether a requested transfer may proceed. */
export type CreditTransferCheck =
  | {ok: true, amount: number}
  | {ok: false, reason: "not_positive" | "insufficient"}

/**
 * Whether a member may move `amount` credits into an organization's wallet.
 *
 * Pure, so the refusal is pinned by a spec rather than discovered in a
 * transaction. The two refusals are separate because they are different answers
 * to the customer: nothing to move versus not enough to move it.
 * @param {*} args The requested amount and what the member actually has free.
 * @return {CreditTransferCheck} The whole amount, or the reason it was refused.
 */
export const validateCreditTransfer = (args: {
  amount: number
  available: number
}): CreditTransferCheck => {
  const amount = Number.isFinite(args.amount) ? Math.floor(args.amount) : 0
  if (amount <= 0) {
    return {ok: false, reason: "not_positive"}
  }
  // Reserved credits are not the member's to give: they are already spoken for by
  // a running job, so paying them into an org would overdraw the wallet.
  if (amount > Math.max(0, args.available)) {
    return {ok: false, reason: "insufficient"}
  }
  return {ok: true, amount}
}

/**
 * Move credits between a member's own wallet and an organization's.
 *
 * Why a transfer and not a grant
 * ------------------------------
 * An organization wallet can only hold credits that came from somewhere. Paying
 * them out of a member's own balance is the only funding route that creates no
 * money: every credit in the org's ledger has a matching debit in a person's.
 * The outward direction is the same fact read backwards, and it is the only way
 * to empty a wallet that `deleteOrganization` refuses to destroy while funded.
 *
 * Why its own transaction
 * -----------------------
 * `applyBillingCreditMutation` opens a transaction around ONE account, so using it
 * twice would leave a window in which the member had paid and the org had not
 * been credited. Both documents and both ledger rows are written together or not
 * at all.
 *
 * The idempotency key covers BOTH rows, with a distinct suffix on each, so a retry
 * after a timeout is a replay rather than a second debit. The suffix names the
 * PEER row: `:org` is what every existing inward transfer already wrote, so it is
 * kept for that direction, and the outward one writes `:user`.
 * @param {*} args Who is moving, which org, how much, which way, under what key.
 * @return {*} Whether it moved, and both balances afterwards.
 */
export const transferOrganizationCredits = async (args: {
  uid: string
  orgId: string
  amount: number
  bucket: CreditBucket
  idempotencyKey: string
  /** `fromOrg` returns the workspace balance to the member. Default `toOrg`. */
  direction?: "toOrg" | "fromOrg"
}): Promise<{
  moved: number
  replayed: boolean
  personalAvailable: number
  organizationAvailable: number
}> => {
  const toOrg = (args.direction || "toOrg") === "toOrg"

  const check = validateCreditTransfer({amount: args.amount, available: Infinity})
  if (!check.ok) {
    throw new Error(`Credit transfer refused: ${check.reason}`)
  }

  const personalRef = db.doc(billingDocPath(args.uid))
  const orgRef = db.doc(billingDocPath(args.uid, args.orgId))
  const personalLedger = getLedgerRef(
    args.uid,
    toOrg ? args.idempotencyKey : `${args.idempotencyKey}:user`,
  )
  const orgLedger = getLedgerRef(
    args.uid,
    toOrg ? `${args.idempotencyKey}:org` : args.idempotencyKey,
    args.orgId,
  )
  const sourceLedger = toOrg ? personalLedger : orgLedger

  return db.runTransaction(async (transaction) => {
    const [personalSnap, orgSnap, sourceLedgerSnap] = await Promise.all([
      transaction.get(personalRef),
      transaction.get(orgRef),
      transaction.get(sourceLedger),
    ])

    const personal = getCreditAmounts(
      personalSnap.data() as BillingSnapshot | undefined,
      args.bucket,
    )
    const organization = getCreditAmounts(
      orgSnap.data() as BillingSnapshot | undefined,
      args.bucket,
    )

    // The replay check comes FIRST: a retried transfer must not be refused for a
    // balance it already paid, which would leave the caller unable to tell "it
    // worked" from "it never will".
    if (sourceLedgerSnap.exists) {
      return {
        moved: 0,
        replayed: true,
        personalAvailable: Math.max(0, personal.balance - personal.reserved),
        organizationAvailable: Math.max(0, organization.balance - organization.reserved),
      }
    }

    // The SOURCE pays, so the source is what has to cover it.
    const source = toOrg ? personal : organization
    const amount = validateCreditTransfer({
      amount: args.amount,
      available: source.balance - source.reserved,
    })
    if (!amount.ok) {
      throw new Error(`Credit transfer refused: ${amount.reason}`)
    }

    const nextPersonal = toOrg ?
      personal.balance - amount.amount :
      personal.balance + amount.amount
    const nextOrg = toOrg ?
      organization.balance + amount.amount :
      organization.balance - amount.amount

    transaction.set(personalRef, {
      credits: buildCreditsPayload(
        personalSnap.data() as BillingSnapshot | undefined,
        args.bucket,
        nextPersonal,
        personal.reserved,
      ),
      updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true})

    transaction.set(orgRef, {
      credits: buildCreditsPayload(
        orgSnap.data() as BillingSnapshot | undefined,
        args.bucket,
        nextOrg,
        organization.reserved,
      ),
      updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true})

    // The deltas are DERIVED from the balances that were just computed, not restated
    // with a sign: the outward direction swaps which side is debited, and a second
    // hand-written sign is exactly how that gets written backwards.
    const personalDelta = nextPersonal - personal.balance
    const orgDelta = nextOrg - organization.balance
    const row = {
      source: "organization_transfer",
      bucket: args.bucket,
      reason: toOrg ? "organization.fund" : "organization.withdraw",
      reservedDelta: 0,
      metadata: {orgId: args.orgId, uid: args.uid},
      createdAt: FieldValue.serverTimestamp(),
    }

    transaction.set(personalLedger, {
      ...row,
      operation: "adjust",
      delta: personalDelta,
      balanceDelta: personalDelta,
      idempotencyKey: toOrg ? args.idempotencyKey : `${args.idempotencyKey}:user`,
    })
    transaction.set(orgLedger, {
      ...row,
      operation: "adjust",
      delta: orgDelta,
      balanceDelta: orgDelta,
      idempotencyKey: toOrg ? `${args.idempotencyKey}:org` : args.idempotencyKey,
    })

    return {
      moved: amount.amount,
      replayed: false,
      personalAvailable: Math.max(0, nextPersonal - personal.reserved),
      organizationAvailable: Math.max(0, nextOrg - organization.reserved),
    }
  })
}
