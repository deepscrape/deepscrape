/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * `GET /api/pricing/rates` - what the platform charges, read from the table that
 * does the charging.
 *
 * Why this route exists at all
 * ---------------------------
 * Roadmap `07` Part G, item 2: a hand-written pricing page drifts from the code.
 * The drift is silent and asymmetric - the code keeps charging correctly while the
 * page advertises a number that is no longer true - and the only way to prevent it
 * is to have ONE source and render it. `resolveBillingPricingPolicy` is that
 * source, `getPublicPricingRates` is its projection, and this route is the seam
 * that lets the app render it instead of restating it.
 *
 * Why the response has no route patterns
 * --------------------------------------
 * The projection drops `pattern`. Those regexes describe our internal routing
 * (`^/machines/machine/[^/]+/start$`) and a pricing surface has no use for them;
 * shipping them would publish the route table for no benefit. The same reasoning
 * that keeps `machineId` out of `BrowserSessionPublic`.
 *
 * This module imports ONLY the pure pricing domain, which reads env at load and
 * builds no Firestore client, so unlike the browser-session handlers it can be
 * imported by a test without an emulator.
 */
import { Request, Response } from "express"
import {
  estimateBillingCost,
  getDefaultPricingRate,
  getPublicPricingRates,
} from "../domain/billing-pricing.domain"

/**
 * `GET /api/pricing/rates` - the active rates, and the fallback.
 *
 * `fallback` is a separate field rather than another entry in `rates`. It is a
 * different statement: the list is what specific actions cost, and the fallback is
 * what an unpriced route costs. Folding it into the list would present
 * `api.paid.default` as an action a customer can choose.
 *
 * A 500 rather than an empty list when this fails. An empty rate list would make
 * the page render "nothing is priced", which is a false claim about the product
 * rather than a report that one read failed.
 * @param {Request} _req The request. Unused: the rates are the same for everyone.
 * @param {Response} res The response.
 * @return {Promise<void>} Nothing.
 */
export const pricingRates = async (
  _req: Request,
  res: Response
): Promise<void> => {
  try {
    res.status(200).json({
      status: "ok",
      rates: getPublicPricingRates(),
      fallback: getDefaultPricingRate(),
    })
  } catch (error) {
    console.error("[pricing] rates failed", error)
    res.status(500).json({status: "error", code: "pricing_unavailable"})
  }
}

/**
 * `GET /api/pricing/estimate` - what the NEXT call costs THIS caller.
 *
 * Why the caller's tier is an input
 * ---------------------------------
 * A price list answers "what does a crawl cost?". This answers "what will MY crawl
 * cost?", and for a free-tier account the answer is zero even though the table
 * lists 3. So `resolveAccess` runs ahead of this handler and the tier it resolved is
 * what decides `chargeable`; the handler never re-reads billing, which is what keeps
 * the estimate from disagreeing with the charge that follows it.
 *
 * Why there is no `count`
 * ----------------------
 * The charge is FLAT per request, not per unit of payload: `requirePaidAccess`
 * reserves `policy.credits` once. A batch of fifty URLs is one `POST /crawl` and
 * costs one `crawl.execute`. Accepting a multiplier would let the UI quote a price
 * the platform does not charge, which is worse than quoting nothing.
 *
 * Accepts the path with or without the `/api` mount, because the client sends the
 * path it is about to call (`/api/crawl`) while the table is keyed on the mount
 * relative one (`/crawl`); the resolver normalizes, so both give the same answer.
 * @param {Request} req The request. `method` and `path` arrive as query params.
 * @param {Response} res The response.
 * @return {Promise<void>} Nothing.
 */
export const pricingEstimate = async (
  req: Request,
  res: Response
): Promise<void> => {
  const method = typeof req.query?.method === "string" ? req.query.method.trim() : ""
  const path = typeof req.query?.path === "string" ? req.query.path.trim() : ""

  // A 400 rather than a fallback price: an estimate for "no route" would be a
  // number for a call nobody can make. `path` is the one thing this needs.
  if (!path) {
    res.status(400).json({status: "error", code: "path_required"})
    return
  }

  try {
    res.status(200).json({
      status: "ok",
      estimate: estimateBillingCost(method || "POST", path, req.accessMode),
    })
  } catch (error) {
    console.error("[pricing] estimate failed", error)
    res.status(500).json({status: "error", code: "pricing_unavailable"})
  }
}
