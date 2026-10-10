/* eslint-disable object-curly-spacing */
/**
 * The admin projection of the webrain configuration.
 *
 * Why this is a separate module
 * -----------------------------
 * The store (`infrastructure/webrain-config.store.ts`) owns the token and the
 * proxy pool, and it is the only reader of `WEBRAIN_CONFIG`. What an operator
 * MAY SEE of that state is a different question, and one that has to be
 * answered somewhere a spec can reach: the store imports Firebase Admin and a
 * Secret Manager client at module load, so a spec cannot import it. The
 * transforms below are pure, which pins the two rules that matter -- nothing
 * here emits the token, and nothing here emits a proxy URL.
 *
 * The masking rule
 * ----------------
 * A stored proxy is `scheme://user:pass@host:port`, i.e. a credential. The
 * admin surface therefore shows `label` (operator-authored) and `host` (bare
 * host and port, credentials stripped). The scheme goes too: `http:` versus
 * `https:` tells an operator nothing they need from a status call.
 */
import { randomBytes } from "node:crypto"
import type { ProxyEntry } from "./webrain-proxy.domain"

/** The fixed placeholder for a URL that cannot be parsed. Never a value. */
export const UNPARSEABLE_HOST = "invalid"

/** The schemes a stored proxy may use. Anything else is rejected. */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "socks5:",
])

/** A proxy exit as the admin surface may show it. */
export interface PublicProxyEntry {
  label: string
  host: string
}

/** The `GET /webrain/config` body. No token, no full URL, no length hint. */
export interface PublicWebrainConfig {
  hasToken: boolean
  proxies: PublicProxyEntry[]
  poolSize: number
  source: string
}

/** A proxy exit as the admin supplies it, before validation. */
export interface ProxyInput {
  label: string
  url: string
}

/**
 * A validation outcome.
 *
 * The failure names the offending INDEX and a fixed reason, never the entry: a
 * proxy URL is `user:pass@host`, so an error that quoted the bad value would
 * put a credential in the response body and in the log at once.
 */
export type ProxyValidation =
  | { ok: true; proxies: ProxyInput[] }
  | { ok: false; index: number; reason: string }

/**
 * The bare `host:port` of a proxy URL, with any `user:pass@` removed.
 * @param {string} url The stored proxy URL.
 * @return {string} The host and port, or a fixed placeholder.
 */
export const maskProxyHost = (url: string): string => {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname) {
      return UNPARSEABLE_HOST
    }

    return parsed.port ?
      `${parsed.hostname}:${parsed.port}` :
      parsed.hostname
  } catch {
    return UNPARSEABLE_HOST
  }
}

/**
 * The public projection of a pool: label plus masked host, in stored order.
 * @param {ProxyEntry[]} proxies The resolved pool.
 * @return {PublicProxyEntry[]} One safe entry per proxy.
 */
export const toPublicProxies = (
  proxies: ProxyEntry[]
): PublicProxyEntry[] =>
  proxies.map((entry) => ({
    label: entry.label,
    host: maskProxyHost(entry.url),
  }))

/**
 * The public projection of the resolved pair.
 *
 * `hasToken` is a presence bit, not a prefix or a length: a length is a hint an
 * offline attacker can attack, and a prefix is a credential.
 * @param {*} input The resolved token, pool and source.
 * @return {PublicWebrainConfig} A body with no credential in it.
 */
export const toPublicConfig = (input: {
  mcpToken: string
  proxies: ProxyEntry[]
  source: string
}): PublicWebrainConfig => ({
  hasToken: input.mcpToken.trim().length > 0,
  proxies: toPublicProxies(input.proxies),
  poolSize: input.proxies.length,
  source: input.source,
})

/**
 * Validates a `{ proxies: [...] }` body, naming the first offending index.
 *
 * An empty array is refused rather than treated as "clear the pool": clearing
 * silently would move every caller back to a direct exit, which is the
 * opposite of what an operator replacing a burned proxy intends.
 * @param {unknown} input The raw request body.
 * @return {ProxyValidation} The usable entries, or the offending index.
 */
export const validateProxyInput = (input: unknown): ProxyValidation => {
  const record = input && typeof input === "object" ?
    (input as { proxies?: unknown }) :
    {}
  const raw = record.proxies

  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      index: -1,
      reason: "proxies must be a non-empty array",
    }
  }

  const proxies: ProxyInput[] = []

  for (let index = 0; index < raw.length; index += 1) {
    const item: unknown = raw[index]

    if (!item || typeof item !== "object") {
      return { ok: false, index, reason: "proxy must be an object" }
    }

    const entry = item as { label?: unknown; url?: unknown }
    const label = typeof entry.label === "string" ? entry.label.trim() : ""
    if (!label) {
      return { ok: false, index, reason: "label is required" }
    }

    const url = typeof entry.url === "string" ? entry.url.trim() : ""
    if (!url) {
      return { ok: false, index, reason: "url is required" }
    }

    let protocol = ""
    try {
      protocol = new URL(url).protocol
    } catch {
      return { ok: false, index, reason: "url is not a valid URL" }
    }

    if (!ALLOWED_PROTOCOLS.has(protocol)) {
      return {
        ok: false,
        index,
        reason: "url must use http, https or socks5",
      }
    }

    proxies.push({ label, url })
  }

  return { ok: true, proxies }
}

/**
 * A fresh MCP bearer token: 32 random bytes, URL-safe.
 *
 * `base64url` avoids the `+/=` that a bearer header or a shell paste can
 * mangle, and 32 bytes matches every other secret this repository generates.
 * @return {string} A token fit for the worker's bearer header.
 */
export const generateMcpToken = (): string =>
  randomBytes(32).toString("base64url")

/**
 * The token to store for a request body, minting one when none was supplied.
 *
 * A blank or absent `token` means "generate": an operator rotating a credential
 * should not have to invent one, and the worker only ever reads it as an opaque
 * bearer string.
 * @param {unknown} body The raw request body.
 * @return {*} The token plus whether this request minted it.
 */
export const resolveTokenUpdate = (
  body: unknown
): { token: string; generated: boolean } => {
  const record = body && typeof body === "object" ?
    (body as { token?: unknown }) :
    {}
  const requested =
    typeof record.token === "string" ? record.token.trim() : ""

  if (requested) {
    return { token: requested, generated: false }
  }

  return { token: generateMcpToken(), generated: true }
}
