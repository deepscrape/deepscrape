/**
 * The platform's price list, as the app renders it.
 *
 * The SET and the NUMBERS come from the server, which reads them from the same
 * table the charging path uses (`resolveBillingPricingPolicy`). This shape exists
 * so the app can RENDER that table rather than restate it: a page that hard-codes
 * the numbers drifts the first time a rate changes, and the drift is silent,
 * because the code keeps charging correctly while the page advertises a lie.
 *
 * There is deliberately no `pattern` field. The server does not send the route
 * regexes, because a price list has no use for our internal routing and shipping
 * them would publish the route table for no benefit.
 */

/** One priced action. */
export interface PricingRate {
  /** The action id, e.g. `crawl.execute`. Also the fallback for a label. */
  action: string
  /**
   * The HTTP method the rate applies to.
   *
   * Absent on the fallback rate, which applies to every method. Typed optional
   * rather than defaulted, because filling in a method there would be a claim that
   * is not true.
   */
  method?: string
  /** What the action costs, in credits. */
  credits: number
}

/**
 * The reply to a rates read.
 *
 * `fallback` is a separate field rather than another entry in `rates`. It is the
 * price of an action that is not listed, and presenting it in the list would imply
 * a customer can choose it.
 */
export interface PricingRatesResponse {
  status: 'ok'
  rates: PricingRate[]
  fallback: PricingRate
}

/**
 * What the next call costs THIS caller.
 *
 * Deliberately not `PricingRate`: a rate is what an action costs in the table,
 * while this is what the caller would actually be charged, and those differ by
 * tier. A free-tier account pays nothing even for a listed action, so `credits`
 * (the table's price) and `effectiveCredits` (what will be taken) are both
 * reported and are meant to disagree.
 */
export interface PricingEstimate {
  method: string
  path: string
  /** The action id the route resolves to, e.g. `crawl.execute`. */
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

/** The reply to an estimate read. */
export interface PricingEstimateResponse {
  status: 'ok'
  estimate: PricingEstimate
}
