/* eslint-disable object-curly-spacing */
/**
 * The one target-URL guard.
 *
 * Why this module exists
 * ---------------------
 * `handlers/ai_handler.ts` carried this allowlist + blocklist inline, and this
 * repo's own rule is that the guard lives in exactly one place: a second copy
 * is
 * a second thing to keep correct, and the copy that drifts is the one nobody
 * reads. Adding the webrain path made the second copy imminent, so it moved
 * here
 * first.
 *
 * **What it does and does not do — read this before trusting it.**
 *
 * It runs BEFORE the request. A target that redirects to a blocked address
 * defeats it completely, because the redirect is followed inside the crawler's
 * own HTTP client, after this function has returned. That half cannot be fixed
 * here and is not pretended otherwise; enforcement belongs where the connection
 * is made (no-follow, or per-hop revalidation in the worker). webrain's
 * `validate_urls` does NOT close it either — it applies no private-address
 * policy
 * at all and reports only `{url, alive}`. See
 * `docs/RESIDUAL-RISK-CRAWL-TRUST-BOUNDARY.md` §6.
 *
 * So: this is the cheap, necessary half. It is not the whole guard.
 */

/** Rejected outright, before any parse: longer than any legitimate target. */
export const TARGET_URL_MAX_LENGTH = 2048

/** Ceiling on how many targets one request may enqueue. */
export const MAX_TARGETS = 50

/**
 * Hosts the crawler must never be pointed at: loopback, IPv4 private ranges,
 * link-local (which is where cloud metadata lives — `169.254.169.254`), IPv6
 * loopback and unique-local, and the internal-only TLDs.
 */
export const BLOCKED_HOST = /^(localhost|\.?0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|.*\.local$|.*\.internal$)/i

/** True when the host resolves into space we must not be able to read.
 * @param {*} hostname
 * @return {*}
 */
export const isBlockedHost = (hostname: string): boolean => BLOCKED_HOST.test(hostname)

/**
 * True when a single candidate is a target we are willing to hand to a worker:
 * http(s), short enough, and not pointed at private space.
 *
 * Anything unparseable is refused rather than passed through — a URL the
 * platform
 * cannot understand is not one it can vouch for.
 * @param {*} candidate
 * @return {*}
 */
export const isSafeTargetUrl = (candidate: unknown): candidate is string => {
  if (typeof candidate !== "string" || candidate.length > TARGET_URL_MAX_LENGTH) {
    return false
  }

  try {
    const parsed = new URL(candidate)
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
            !isBlockedHost(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * Filters an untrusted list down to the targets that may be crawled, capped at
 * `MAX_TARGETS`. A non-array (or an absent field) yields an empty list, so the
 * caller's "no valid targets" branch is the only path that can proceed.
 * @param {*} urls
 * @return {*}
 */
export const safeTargetUrls = (urls: unknown): string[] =>
  Array.isArray(urls) ? urls.filter(isSafeTargetUrl).slice(0, MAX_TARGETS) : []
