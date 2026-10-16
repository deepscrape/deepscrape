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
 * link-local (which is where cloud metadata lives — `169.254.169.254`), the
 * whole non-routable IPv6 set (loopback, unspecified, unique-local `fc00::/7`,
 * link-local `fe80::/10`, multicast `ff00::/8`), and the internal-only TLDs.
 */
export const BLOCKED_HOST =
  // eslint-disable-next-line max-len -- a regex literal cannot be wrapped
  /^(localhost|\.?0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|ff[0-9a-f]{2}:|.*\.local$|.*\.internal$)/i

/**
 * Rewrite an IPv4-mapped IPv6 host into dotted IPv4 so the IPv4 rules judge it.
 *
 * `new URL("http://[::ffff:169.254.169.254]/").hostname` is
 * `"[::ffff:a9fe:a9fe]"` — the parser re-encodes the IPv4 as two hex groups —
 * so matching the text alone cannot see the address underneath. Dotted input
 * (`::ffff:169.254.169.254`) is handled too, for a caller that never went
 * through `URL`.
 * @param {string} host A bracket-free hostname.
 * @return {string} Dotted IPv4 when the host is mapped, else the host.
 */
const unmapIpv4 = (host: string): string => {
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (!hex) {
    return host.replace(/^::ffff:/i, "")
  }
  const high = parseInt(hex[1], 16)
  const low = parseInt(hex[2], 16)
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join(".")
}

/**
 * True when the host resolves into space we must not be able to read.
 *
 * Brackets are stripped first: `new URL` keeps them on `hostname`, so the
 * pattern's `::1$` alternative never matched and every bracketed IPv6 literal
 * passed the guard. Mapped literals are then unwrapped, because the parser's
 * hex form hides the IPv4 from a text match.
 * @param {*} hostname
 * @return {*}
 */
export const isBlockedHost = (hostname: string): boolean => {
  const bare = hostname.replace(/^\[|\]$/g, "")
  return BLOCKED_HOST.test(unmapIpv4(bare))
}

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
  if (
    typeof candidate !== "string" ||
    candidate.length > TARGET_URL_MAX_LENGTH
  ) {
    return false
  }

  try {
    const parsed = new URL(candidate)
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !isBlockedHost(parsed.hostname)
    )
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

/**
 * One untrusted value trimmed and put past the guard, or undefined.
 *
 * The single-field counterpart to `safeTargetUrls`, for the routes that take
 * ONE url rather than a list. It exists so that "trim it, then ask the guard"
 * is written once: `/scrape`, `/monitor/create` and any future single-target
 * route all need exactly this, and a second copy is a second answer to "is this
 * safe?".
 * @param {*} value The candidate.
 * @return {*} The trimmed URL, or undefined when it is not one we may fetch.
 */
export const targetUrlFrom = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return isSafeTargetUrl(trimmed) ? trimmed : undefined
}

/** The schemes a caller-supplied CDP endpoint may use. */
const CDP_PROTOCOLS: readonly string[] = ["ws:", "wss:", "http:", "https:"]

/**
 * A caller-supplied CDP endpoint, or undefined when we will not dial it.
 *
 * Deliberately a SIBLING of `isSafeTargetUrl` rather than a flag on it, because
 * the two answer different questions. That one answers "may we FETCH this", and
 * a `ws://` URL is nothing the fetch path can act on, so widening it would
 * change the answer for every existing caller. This answers "may a worker DIAL
 * this", where `ws:` and `wss:` are the *normal* spellings -- the hosted CDP
 * providers (Browserless, Browserbase, Steel) hand out exactly those, usually
 * with the token in the path or query.
 *
 * Built on `isBlockedHost`, the same predicate `isSafeTargetUrl` uses, and that
 * is the load-bearing half: a caller-supplied endpoint is an attacker-chosen
 * address, so it must not resolve into private space. It shares that guard's
 * documented limit too -- it judges the HOST, not where the host resolves, so
 * DNS rebinding is out of scope for a one-shot check (see this file's header).
 *
 * Credentials in the userinfo are refused. No CDP provider needs them, and a
 * `wss://user:pass@host` would otherwise be a credential in a field that is
 * echoed in errors and kept in logs.
 * @param {*} value The caller-supplied endpoint.
 * @return {*} The trimmed endpoint, or undefined when it is not one we dial.
 */
export const cdpEndpointFrom = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > TARGET_URL_MAX_LENGTH) {
    return undefined
  }

  try {
    const parsed = new URL(trimmed)
    if (!CDP_PROTOCOLS.includes(parsed.protocol)) {
      return undefined
    }
    if (parsed.username || parsed.password) {
      return undefined
    }
    return isBlockedHost(parsed.hostname) ? undefined : trimmed
  } catch {
    return undefined
  }
}

/**
 * Filters an untrusted LIST of CDP endpoints, or undefined when any entry is
 * one we will not dial.
 *
 * REFUSES the whole list rather than dropping the bad entries -- the opposite
 * of `safeTargetUrls`, and for `vaultArguments`'s reason. A dropped endpoint
 * does not merely make the request safer, it makes it a DIFFERENT request from
 * the one the caller sent: `webrain_batch` round-robins over this list, so
 * dropping one silently sends calls to a browser the caller did not name while
 * they believe it did.
 *
 * An absent (`undefined`/`null`) field is a legitimate request for "no
 * endpoints", which is how the worker is told to attach to whatever it has. A
 * present-but-empty array is refused instead, because the caller sent a list
 * and a list that names nothing is not the one they meant.
 * @param {*} value The caller-supplied list.
 * @return {string[] | undefined} The trimmed endpoints, or undefined when the
 *   list is present and any entry is unusable.
 */
export const cdpEndpointsFrom = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value) || value.length === 0) {
    return undefined
  }

  const kept: string[] = []
  for (const entry of value) {
    const endpoint = cdpEndpointFrom(entry)
    if (!endpoint) {
      return undefined
    }
    kept.push(endpoint)
  }
  return kept
}

/** The scheme a caller-supplied AI endpoint may use. */
const AI_ENDPOINT_PROTOCOLS: readonly string[] = ["https:"]

/**
 * A caller-supplied AI endpoint, or undefined when we will not send a key to it.
 *
 * The sibling of `cdpEndpointFrom` for the BYOK custom provider, and `https:`-only
 * where that one also allows `ws:`. The reason is what TRAVELS: this endpoint receives
 * the caller's own API key in an `Authorization` header, and plain `http:` would put
 * that credential on the wire in clear text. A crawler target carries no such payload,
 * which is why `isSafeTargetUrl` accepts `http:` and this does not.
 *
 * Userinfo is refused for the same reason as the CDP sibling: the endpoint is echoed
 * back to the caller and written into their settings document, so `https://user:pass@`
 * would persist a credential in a field nothing treats as secret. The key belongs in
 * the key field, which goes to Secret Manager.
 *
 * Private space is refused through `isBlockedHost` -- the load-bearing half, since this
 * is an attacker-chosen address: without it a caller could aim the BFF at
 * `169.254.169.254` and read the metadata service through the proxy. The limit
 * documented at the top of this file applies unchanged: the HOST is judged, not where
 * DNS sends it.
 *
 * A trailing slash is trimmed so the stored base and the request paths built from it
 * cannot produce a doubled separator.
 * @param {*} value The caller-supplied endpoint.
 * @return {*} The trimmed endpoint, or undefined when it is not one we call.
 */
export const aiEndpointFrom = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim().replace(/\/+$/, "")
  if (trimmed.length === 0 || trimmed.length > TARGET_URL_MAX_LENGTH) {
    return undefined
  }

  try {
    const parsed = new URL(trimmed)
    if (!AI_ENDPOINT_PROTOCOLS.includes(parsed.protocol)) {
      return undefined
    }
    if (parsed.username || parsed.password) {
      return undefined
    }
    return isBlockedHost(parsed.hostname) ? undefined : trimmed
  } catch {
    return undefined
  }
}
