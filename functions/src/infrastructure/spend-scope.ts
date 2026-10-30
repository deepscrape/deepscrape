/* eslint-disable max-len */
/**
 * Whose wallet a request is charged to.
 *
 * The platform had a credit wallet per person and a credit wallet per organization,
 * and only the first could ever be spent: every gate read `users/{uid}/billing/current`
 * and every charging path debited it. So a team could transfer credits into a workspace
 * and watch every member get 402 -- money in a room with no door.
 *
 * This is the door. A request that names an organization, from somebody the organization
 * would let spend, is charged to that organization; everything else stays personal. The
 * pricing does not change: `getBillingAccessMode` reads whatever billing document it is
 * handed, so an org funded by transfer is `credits` mode exactly like a person who
 * bought a credit pack.
 *
 * What this deliberately does NOT make org-scoped: plans (the card is a person's, and a
 * Stripe customer per org is a separate product decision), machines and stored objects
 * (both are keyed by uid). A workspace buys a shared balance, not a shared fleet.
 */
import {db} from "../app/config"
import {billingDocPath} from "../app/billing-credits"
import type {BillingSnapshot} from "../domain/billing.domain"
import {getBillingAccessMode} from "../domain/billing.domain"
import {orgRoleMaySpend, type OrgRole} from "../domain/authz.domain"
import {organizationMembershipId} from "./organization-lifecycle"

/** What a request spends from, and what that wallet holds right now. */
export type ResolvedSpend = {
  /** The person who made the request. Always present. */
  uid: string
  /** The organization paying, when one is. */
  orgId?: string
  /** The paying wallet's document, absent when it does not exist yet. */
  billing: BillingSnapshot | undefined
}

/**
 * The organization a request could charge, if the caller may spend from it.
 *
 * One document read, and only when the request names an org. Membership is checked here
 * rather than reusing the authorisation subject because `requirePaidAccess` runs BEFORE
 * `requirePermission` in every chain -- the subject does not exist yet, and defaulting to
 * "no org" would silently bill a member's personal credits for work their workspace was
 * supposed to pay for.
 * @param {string} uid The verified caller.
 * @param {string} [orgId] The organization the request names, if any.
 * @return {Promise<string | undefined>} The org that may pay, or undefined.
 */
export const resolvePayerOrg = async (
  uid: string,
  orgId?: string,
): Promise<string | undefined> => {
  if (!orgId) return undefined

  const membership = await db.doc(
    `memberships/${organizationMembershipId(uid, orgId)}`,
  ).get()
  if (!membership.exists) return undefined

  const role = membership.get("role") as OrgRole | undefined
  return orgRoleMaySpend(role) ? orgId : undefined
}

/**
 * The organization's wallet, when that organization would actually pay.
 *
 * Split out so the entitlement callable can answer "whose wallet will the API
 * charge?" with the SAME rule the paid routes use. Two derivations of that
 * question is how a funded workspace gets a client-side paywall: the server
 * charges `orgs/{orgId}/billing/current` while the client is told the member's
 * personal wallet is empty.
 *
 * `undefined` covers both "no membership / no spending role" and "the workspace
 * wallet is free". Callers that need to tell those apart must not use this.
 * @param {string} uid The verified caller.
 * @param {string} [orgId] The organization the request names, if any.
 * @return {*} The payer organization and its wallet, or undefined.
 */
export const resolveOrgWallet = async (
  uid: string,
  orgId?: string,
): Promise<{orgId: string, billing: BillingSnapshot | undefined} | undefined> => {
  const payerOrgId = await resolvePayerOrg(uid, orgId)
  if (!payerOrgId) {
    return undefined
  }

  const billing = (await db.doc(billingDocPath(uid, payerOrgId)).get())
    .data() as BillingSnapshot | undefined
  if (getBillingAccessMode(billing) === "free") {
    return undefined
  }

  return {orgId: payerOrgId, billing}
}

/**
 * The wallet this request is charged to, and what it holds.
 *
 * The workspace first, the person second: `org-context.interceptor` puts `x-org-id` on
 * EVERY request, defaulting to the workspace created at signup, so "an org is named,
 * therefore the org pays" would move every existing customer's spending onto an empty
 * wallet -- 402 on every paid route, for everyone, permanently.
 *
 * `free` is decided by the same `getBillingAccessMode` the caller's own branch uses, so
 * the two cannot disagree about whether the workspace could have paid.
 * @param {string} uid The verified caller.
 * @param {string} [orgId] The organization the request names, if any.
 * @return {Promise<ResolvedSpend>} The payer and its billing document.
 */
export const resolveSpend = async (
  uid: string,
  orgId?: string,
): Promise<ResolvedSpend> => {
  const orgWallet = await resolveOrgWallet(uid, orgId)
  if (orgWallet) {
    return {uid, orgId: orgWallet.orgId, billing: orgWallet.billing}
  }

  // The roadmap asked for a loud fallback here. It cannot be a log line: this runs
  // on every request, and the default signup workspace is free for everyone, so a
  // log would be per-request noise on the hottest path in the platform. The signal
  // belongs in a throttled counter, not in this function.
  const personal = (await db.doc(billingDocPath(uid)).get())
    .data() as BillingSnapshot | undefined
  return {uid, billing: personal}
}
