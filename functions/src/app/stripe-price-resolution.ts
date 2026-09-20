/* eslint-disable max-len */
/**
 * Stripe price resolution by `lookup_key`.
 *
 * Why this exists: the catalog used to carry hardcoded `price_…` ids, and Stripe ids do
 * not cross modes. The 14 ids in the catalog are test-mode (`livemode: false`, account
 * `acct_1Qag9KFVGcR0rD8f`), so a live deployment with unset env vars failed every checkout
 * with "No such price". Lookup keys are mode- and environment-independent, so ONE
 * deployment now works against test and live alike.
 *
 * Convention, set on the account and verified against the Stripe API on 2026-09-20:
 * `ds_<plan>_<interval>` and `ds_credits_<n>`, with the interval shortened because the
 * keys are already live in that form (`payAsYouGo` -> `payg`, `annually` -> `annual`).
 *
 * The live catalog still has to be created in whichever account owns production. These
 * keys only remove the need to redeploy with different ids.
 */

/** Interval names are shortened to match the keys that are actually live in Stripe. */
const SHORT_INTERVAL: Record<string, string> = {
  monthly: "monthly",
  quarterly: "quarterly",
  annually: "annual",
  payAsYouGo: "payg",
}

/** Minimal slice of the Stripe client this module needs, so tests can pass a stub. */
type PriceLister = {
  prices: {
    list: (params: {lookup_keys: string[]; limit: number}) => Promise<{data: {id: string}[]}>
  }
}

/** A client that can also confirm a price id exists, which is what the hourly check needs. */
type PriceReader = PriceLister & {
  prices: {
    retrieve: (id: string) => Promise<unknown>
  }
}

/** A catalog price as the hourly check sees it: the key to ask for, and the id to fall back to. */
export type CatalogPriceEntry = {key: string, fallbackId?: string}

/**
 * Lookup key for a plan+interval price.
 *
 * @param {string} plan Plan tier, e.g. "pro".
 * @param {string} interval Billing interval, e.g. "annually".
 * @return {string} The lookup key.
 */
export const lookupKeyForPlan = (plan: string, interval: string): string =>
  `ds_${plan}_${SHORT_INTERVAL[interval] ?? interval}`

/**
 * Lookup key for a credit pack.
 *
 * @param {number} credits Pack size, e.g. 500.
 * @return {string} The lookup key.
 */
export const lookupKeyForCredits = (credits: number): string => `ds_credits_${credits}`

// ponytail: instance-lifetime cache, no TTL. Prices are immutable, so the only way an
// entry goes stale is transferring a lookup_key to a different price, which needs a cold
// start (or redeploy) to be picked up.
const priceIdCache = new Map<string, string>()

/**
 * Resolve a price id by lookup_key, falling back to the catalog id.
 *
 * The fallback is the whole point: it is what every caller did before this existed, so a
 * Stripe outage, a missing key, or a cold cache degrades to today's behaviour rather than
 * breaking checkout. A miss is logged because it means the account and this convention
 * disagree, which is worth seeing before a customer does.
 *
 * @param {PriceLister} stripe Initialised Stripe client.
 * @param {string} lookupKey Key to resolve.
 * @param {string} fallbackId Catalog price id to use when the key does not resolve.
 * @return {Promise<string | undefined>} Live price id, or the fallback.
 */
export async function resolvePriceId(
  stripe: PriceLister,
  lookupKey: string,
  fallbackId?: string,
): Promise<string | undefined> {
  const cached = priceIdCache.get(lookupKey)
  if (cached) {
    return cached
  }

  try {
    const {data} = await stripe.prices.list({lookup_keys: [lookupKey], limit: 1})
    const resolved = data[0]?.id

    if (resolved) {
      priceIdCache.set(lookupKey, resolved)
      return resolved
    }

    console.warn(
      `[billing] lookup_key ${lookupKey} not found in this Stripe account; ` +
      `falling back to ${fallbackId ?? "nothing"}`,
    )
  } catch (error) {
    console.warn(
      `[billing] lookup_key ${lookupKey} lookup failed; falling back to ${fallbackId ?? "nothing"}`,
      error,
    )
  }

  return fallbackId
}

/**
 * Catalog prices that cannot be sold in the connected account, as readable reasons.
 *
 * The question is not "is the lookup_key set" but "would a checkout succeed", because the
 * fallback above hides the difference: a missing key hands back a hardcoded test-mode id,
 * and a live account has never heard of it. Nothing threw, nothing logged as an error, and
 * the first person to find out was the customer whose checkout said "No such price".
 *
 * A fallback id that DOES exist in the account is fine and reported as fine - that is a
 * deployment configured by env vars rather than by lookup keys, and it works.
 *
 * @param {PriceReader} stripe Initialised Stripe client.
 * @param {CatalogPriceEntry[]} entries Catalog prices to check.
 * @return {Promise<string[]>} One reason per unusable price, empty when all are sellable.
 */
export async function findUnusableCatalogPrices(
  stripe: PriceReader,
  entries: CatalogPriceEntry[],
): Promise<string[]> {
  const unusable: string[] = []

  for (const entry of entries) {
    const resolved = await resolvePriceId(stripe, entry.key, entry.fallbackId)
    if (!resolved) {
      unusable.push(`${entry.key} (no price for the key and no fallback id)`)
      continue
    }

    try {
      await stripe.prices.retrieve(resolved)
    } catch {
      unusable.push(`${entry.key} (${resolved} is not a price in this account)`)
    }
  }

  return unusable
}
