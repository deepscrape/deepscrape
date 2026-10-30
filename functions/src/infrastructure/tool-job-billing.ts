/* eslint-disable object-curly-spacing */
/**
 * The charge for one QUEUED tool job, composed rather than inherited.
 *
 * Why this file exists
 * --------------------
 * `POST /api/job/tool` is registered with `access` (`resolveAccess`), not
 * `paid`. That is deliberate and cannot change: a free caller may queue
 * `webrain_serp`, so a `paid` guard would 402 the one tool they are entitled
 * to. But `access` charges NOTHING -- its own doc says a route that should
 * bill composes the charge path explicitly. So every queued playground tool
 * call billed nobody, including a site-wide `spider`.
 *
 * What is charged, and what is not
 * --------------------------------
 * The price comes from the tool's OWN row in `billing-pricing.domain.ts`
 * (`/spider` is 10, `/batch` 3, `/vision` 2, `/watch` 5). A tool with no row
 * of its own -- `serp`, `search`, `extract`, `pdf` -- is NOT charged, because
 * `resolveBillingPricingPolicy` would answer the fallback rate
 * (`api.paid.default`, 1 credit) and that is a NET for an unlisted route, not
 * a price. Charging it here would raise the price of four tools whose direct
 * routes cost nothing, which is a new price this change has no mandate to
 * invent. `toolJobCharge` returning null is that decision, in one place.
 *
 * When it is charged
 * ------------------
 * At ENQUEUE, once per call, exactly like `POST /api/crawl/stream/job` charges
 * its 3 credits: the caller's action is "queue this", and a job that fails on
 * the worker afterwards is still a queued job. Charging per delivery instead
 * would bill a QStash retry of the same unit of work twice.
 *
 * The settle-on-finish hook is the same shape `requirePaidAccess` uses, so a
 * refused enqueue (400 from the mapper, 402 from the tier table) releases the
 * reservation rather than keeping it.
 */
import { Request, Response } from "express"

import {
  consumeBillingCredits,
  releaseBillingCredits,
  reserveBillingCredits,
} from "../app/billing-credits"
import {
  getDefaultPricingRate,
  resolveBillingPricingPolicy,
} from "../domain/billing-pricing.domain"
import type { BillingPricingPolicy } from "../domain/billing-pricing.domain"
import { isChargeableAccessMode } from "../domain/billing.domain"
import { getOrgIdFromRequest } from "./authz.middleware"
import { resolveSpend } from "./spend-scope"

/** A short random suffix, so two calls in one millisecond differ.
 * @return {string} Eight base-36 characters.
 */
const randomSuffix = (): string => Math.random().toString(36).slice(2, 10)

/**
 * The price of one queued tool, or null when that tool has no price of its own.
 *
 * Pure, so "a free tool stays free" is pinned by a test rather than by a live
 * Firestore.
 * @param {string} toolPath The tool's own direct route path, e.g. `/spider`.
 * @return {BillingPricingPolicy | null} The policy, or null to charge nothing.
 */
export const toolJobCharge = (
  toolPath: string
): BillingPricingPolicy | null => {
  const policy = resolveBillingPricingPolicy("POST", toolPath)
  return policy.action === getDefaultPricingRate().action ? null : policy
}

/**
 * Reserve the tool's price for this request and settle it when it answers.
 *
 * Returns the policy it charged, or null when nothing was charged -- the caller
 * stamps that on the operation row, so `/operations` can say what a run cost
 * without re-deriving a price from the table (which would drift).
 *
 * Aborts the enqueue by throwing when the reservation fails, and that is the
 * honest direction: a caller who cannot cover the charge must not receive a
 * queued job. The caller's own catch answers 402.
 * @param {Request} req The enqueue request, already past `access`.
 * @param {Response} res The response the settlement is attached to.
 * @param {string} toolPath The tool's own direct route path.
 * @return {Promise<BillingPricingPolicy | null>} The policy charged, or null.
 */
export const chargeToolJob = async (
  req: Request,
  res: Response,
  toolPath: string
): Promise<BillingPricingPolicy | null> => {
  const uid = req.user?.uid
  const policy = toolJobCharge(toolPath)

  if (!uid || !policy || policy.credits <= 0) {
    return null
  }

  if (!isChargeableAccessMode(req.accessMode)) {
    return null
  }

  const bucket: "purchased" | "included" =
    req.accessMode === "credits" ? "purchased" : "included"
  // The workspace pays when it can and the caller does otherwise, resolved by the same
  // helper the access gate used.
  const spend = await resolveSpend(uid, getOrgIdFromRequest(req))
  const base = `${uid}:POST:job/tool:${Date.now()}:${randomSuffix()}`

  await reserveBillingCredits({
    uid,
    orgId: spend.orgId,
    amount: policy.credits,
    bucket,
    ledger: {
      source: "tool-job",
      reason: `reserve:${policy.action}`,
      metadata: {action: policy.action, tool: toolPath},
      idempotencyKey: `${base}:reserve`,
    },
  })

  res.setHeader("x-billing-credits-reserved", String(policy.credits))
  res.setHeader("x-billing-action", policy.action)

  let settled = false

  /**
   * Take the reservation, or put it back.
   *
   * `settled` guards against both `finish` and `close` firing: the second
   * settlement would otherwise consume twice or release what was just spent.
   * @param {boolean} shouldConsume Whether the request is being answered 2xx.
   * @return {Promise<void>} Resolves once the ledger is committed.
   */
  const settle = async (shouldConsume: boolean): Promise<void> => {
    if (settled) {
      return
    }

    settled = true

    try {
      if (shouldConsume) {
        await consumeBillingCredits({
          uid,
          orgId: spend.orgId,
          amount: policy.credits,
          bucket,
          releaseReserved: true,
          ledger: {
            source: "tool-job",
            reason: `consume:${policy.action}`,
            metadata: {
              action: policy.action,
              tool: toolPath,
              statusCode: res.statusCode,
            },
            idempotencyKey: `${base}:consume`,
          },
        })
        return
      }

      await releaseBillingCredits({
        uid,
        orgId: spend.orgId,
        amount: policy.credits,
        bucket,
        ledger: {
          source: "tool-job",
          reason: `release:${policy.action}`,
          metadata: {
            action: policy.action,
            tool: toolPath,
            statusCode: res.statusCode,
          },
          idempotencyKey: `${base}:release`,
        },
      })
    } catch (error) {
      // Logged, not rethrown: the response is already written and a settlement
      // failure must not become a 500 for a job that was queued successfully.
      console.error("Tool job credit settlement failed:", error)
    }
  }

  res.once("finish", () => {
    // RETURNED, not `void`ed: the BFF's bridge awaits its listeners, and Cloud
    // Run can freeze an instance the moment a response goes out -- a
    // settlement still in flight would then be lost, leaving the reservation
    // standing and the customer short of credits.
    return settle(res.statusCode >= 200 && res.statusCode < 400)
  })

  return policy
}
