/* eslint-disable max-len */
import {env} from "../config"
import {isChargeableAccessMode} from "./billing.domain"

export type BillingPricedMethod = "GET" | "POST" | "PUT" | "DELETE"

export type BillingPricingPolicy = {
  action: string
  credits: number
}

export type BillingPricingRule = {
  method: BillingPricedMethod
  pattern: string
  policy: BillingPricingPolicy
}

const defaultPricingRules: BillingPricingRule[] = [
  {method: "POST", pattern: "^/anthropic/messages$", policy: {action: "ai.anthropic.messages", credits: 2}},
  {method: "POST", pattern: "^/openai/chat/completions$", policy: {action: "ai.openai.chat", credits: 2}},
  {method: "POST", pattern: "^/groq/chat/completions$", policy: {action: "ai.groq.chat", credits: 1}},
  // A crawl costs the same whether it is queued directly, streamed, or run by the
  // domain seeder: the work is identical, and `crawl.execute` is the one action the
  // rates page publishes for it. All three paths share ONE row, deliberately --
  // `getPublicPricingRates` maps rules 1:1 with no dedupe, so a second row carrying
  // the same action would publish the same price twice on the pricing page.
  //
  // The streaming enqueue used to fall through to `api.paid.default` (1 credit)
  // purely because no rule matched its path, which undercharged by 2 and made the
  // published rate a fiction for that route.
  {method: "POST", pattern: "^/(?:crawl(?:/stream/job)?|seeder/stream/job/multi-research)$", policy: {action: "crawl.execute", credits: 3}},
  // Reading a job you already paid to enqueue is FREE, and these two rows exist to
  // say so explicitly rather than by omission. Without them the default applies to
  // every unmatched method, so a client polling `/job/stream/status/:id` was charged
  // 1 credit PER POLL -- billing a customer for watching their own job, and the
  // longer it ran the more it cost. A zero-credit rule is the mechanism: the charger
  // tests `policy.credits > 0`, so no reservation is taken and no ledger entry is
  // written (see the charge block in syncaiapi.ts).
  //
  // Both status spellings share one row for the same 1:1 reason as above. They cannot
  // be confused with the results stream below: `[^/]+` will not span the `/` in
  // `status/:id`, so `/crawl/stream/job/status/abc` never reaches that pattern.
  {method: "GET", pattern: "^/(?:crawl/stream/job/status|job/stream/status)/[^/]+$", policy: {action: "crawl.stream.status", credits: 0}},
  {method: "GET", pattern: "^/crawl/stream/job/[^/]+$", policy: {action: "crawl.stream.results", credits: 0}},
  {method: "POST", pattern: "^/machines/deploy$", policy: {action: "machines.deploy", credits: 5}},
  {method: "GET", pattern: "^/machines/machine/[^/]+$", policy: {action: "machines.read", credits: 1}},
  {method: "GET", pattern: "^/machines/check-image$", policy: {action: "machines.check_image", credits: 1}},
  {method: "GET", pattern: "^/machines/machine/waitforstate/[^/]+$", policy: {action: "machines.wait_for_state", credits: 1}},
  {method: "PUT", pattern: "^/machines/machine/[^/]+/start$", policy: {action: "machines.start", credits: 1}},
  {method: "PUT", pattern: "^/machines/machine/[^/]+/suspend$", policy: {action: "machines.suspend", credits: 1}},
  {method: "PUT", pattern: "^/machines/machine/[^/]+/stop$", policy: {action: "machines.stop", credits: 1}},
  {method: "DELETE", pattern: "^/machines/machine/[^/]+$", policy: {action: "machines.destroy", credits: 2}},
]

const defaultPricingPolicy: BillingPricingPolicy = {
  action: "api.paid.default",
  credits: 1,
}

const validMethods = new Set<BillingPricedMethod>(["GET", "POST", "PUT", "DELETE"])

const normalizeCredits = (value: unknown): number | null => {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null
  }

  return parsed
}

const sanitizeRule = (raw: unknown): BillingPricingRule | null => {
  if (!raw || typeof raw !== "object") {
    return null
  }

  const candidate = raw as {
    method?: unknown
    pattern?: unknown
    policy?: {
      action?: unknown
      credits?: unknown
    }
  }

  const method = typeof candidate.method === "string" ? candidate.method.toUpperCase() : ""
  if (!validMethods.has(method as BillingPricedMethod)) {
    return null
  }

  const pattern = typeof candidate.pattern === "string" ? candidate.pattern.trim() : ""
  if (!pattern) {
    return null
  }

  try {
    // Validate regex once at startup.
    new RegExp(pattern)
  } catch {
    return null
  }

  const action = typeof candidate.policy?.action === "string" ? candidate.policy.action.trim() : ""
  const credits = normalizeCredits(candidate.policy?.credits)
  if (!action || credits === null) {
    return null
  }

  return {
    method: method as BillingPricedMethod,
    pattern,
    policy: {
      action,
      credits,
    },
  }
}

const parseRulesFromEnv = (): BillingPricingRule[] | null => {
  const raw = (env.BILLING_PRICING_RULES_JSON || "").trim()
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return null
    }

    const rules = parsed
      .map((entry) => sanitizeRule(entry))
      .filter((entry): entry is BillingPricingRule => Boolean(entry))

    return rules.length ? rules : null
  } catch {
    return null
  }
}

const activeRules: BillingPricingRule[] = parseRulesFromEnv() || defaultPricingRules

/**
 * The route key a price is looked up by.
 *
 * The table's patterns are relative to the `/api` mount (`^/crawl$`), because the
 * Express host handed a router handler the path MINUS the mount. The BFF's bridge
 * has no mount to subtract, so it hands the FULL pathname (`/api/crawl`) — and
 * before this existed, the two spellings resolved to different policies: the
 * mounted-relative one matched its rule, the full one fell through to
 * `api.paid.default`. Every priced route on the BFF therefore charged 1 credit
 * while the rates page advertised its table price, which is precisely the silent
 * drift the single table exists to prevent.
 *
 * Normalizing here rather than at each call site is the same "one place" reasoning
 * the rest of this module uses: a caller cannot forget, and a new host cannot
 * introduce a third spelling. The lookahead leaves `/apiculture` alone.
 * @param {string} routePath The request path, with or without the `/api` mount.
 * @return {string} The path relative to the `/api` mount.
 */
const normalizeRoutePath = (routePath: string): string =>
  (routePath || "").replace(/^\/api(?=\/|$)/, "")

export const resolveBillingPricingPolicy = (
  method: string,
  routePath: string,
): BillingPricingPolicy => {
  const normalizedMethod = method.toUpperCase()
  const path = normalizeRoutePath(routePath)

  const matched = activeRules.find((rule) => {
    if (rule.method !== normalizedMethod) {
      return false
    }

    return new RegExp(rule.pattern).test(path)
  })

  return matched?.policy || defaultPricingPolicy
}

/**
 * One call's cost, as `GET /api/pricing/estimate` reports it.
 *
 * Distinct from `PublicPricingRate` because it answers a different question. A rate
 * is what an action costs in the table; this is what THIS caller would actually be
 * charged for the next call, which depends on their entitlement — a free-tier
 * caller is charged nothing even for a priced action.
 */
export type BillingCostEstimate = {
  method: string
  path: string
  action: string
  /** The table's price for one call to this route, in credits. */
  credits: number
  /** The entitlement the request would be priced under. */
  accessMode: string
  /** False on the free tier and for a platform admin, who are charged nothing. */
  chargeable: boolean
  /** `credits` when chargeable, else 0. What the customer actually pays. */
  effectiveCredits: number
}

/**
 * What the next call to `method routePath` costs THIS caller.
 *
 * Reuses `resolveBillingPricingPolicy` and `isChargeableAccessMode` rather than
 * restating either, so the estimate cannot advertise a number the charging path
 * would not take. The charge is FLAT per call, not per unit of payload, so there is
 * deliberately no `count` input: a batch crawl of fifty URLs is one request and
 * costs one `crawl.execute`, and multiplying here would quote a price the platform
 * does not charge.
 * @param {string} method The HTTP method of the call being priced.
 * @param {string} routePath Its path, with or without the `/api` mount.
 * @param {string|undefined} accessMode The entitlement `resolveAccess` resolved.
 * @return {BillingCostEstimate} The price, and whether it will be applied.
 */
export const estimateBillingCost = (
  method: string,
  routePath: string,
  accessMode: string | undefined,
): BillingCostEstimate => {
  const policy = resolveBillingPricingPolicy(method, routePath)
  const chargeable = policy.credits > 0 && isChargeableAccessMode(accessMode)

  return {
    method: method.toUpperCase(),
    path: routePath || "",
    action: policy.action,
    credits: policy.credits,
    accessMode: accessMode || "free",
    chargeable,
    effectiveCredits: chargeable ? policy.credits : 0,
  }
}

export const getBillingPricingRules = (): BillingPricingRule[] => {
  return activeRules
}

/**
 * One rate, as a client may see it.
 *
 * Deliberately WITHOUT `pattern`. Those regexes describe the internal route shape
 * (`^/machines/machine/[^/]+/start$`), and a pricing surface has no use for them:
 * a customer cares what an action costs, not how the router spells it. Shipping
 * them would publish our routing table for no benefit, which is the same
 * reasoning that keeps `machineId` out of `BrowserSessionPublic`.
 */
export type PublicPricingRate = {
  action: string
  /** Absent for the fallback rate, which applies to every method. */
  method?: BillingPricedMethod
  credits: number
}

/**
 * The priced actions, in declaration order, as the app may render them.
 *
 * This exists so the pricing UI can be DERIVED rather than hand-written. A page
 * that restates the numbers drifts the first time a rate changes, and the drift is
 * invisible: the code charges one price and the page advertises another. Reading
 * the table means a new rule appears on the page by existing.
 *
 * It reads `activeRules`, so it reflects `BILLING_PRICING_RULES_JSON` when that
 * env var is set. That is the point: an operator who re-prices through the env
 * changes the charged amount and the advertised amount in one move.
 *
 * Note this is NOT a proposal for what things should cost. It is a report of what
 * they DO cost, which is why it belongs next to `resolveBillingPricingPolicy` and
 * not in a marketing file.
 * @return {PublicPricingRate[]} The active rates, without their patterns.
 */
export const getPublicPricingRates = (): PublicPricingRate[] =>
  activeRules.map((rule) => ({
    action: rule.policy.action,
    method: rule.method,
    credits: rule.policy.credits,
  }))

/**
 * What an unpriced route costs.
 *
 * Exposed separately from `getPublicPricingRates` because it is a different
 * statement. The listed rates are what specific actions cost; this is the price
 * of anything not listed, and a page that folded it into the list would imply
 * `api.paid.default` is an action a customer can choose.
 * @return {PublicPricingRate} The fallback rate.
 */
export const getDefaultPricingRate = (): PublicPricingRate => ({
  action: defaultPricingPolicy.action,
  credits: defaultPricingPolicy.credits,
})
