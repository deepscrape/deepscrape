/* eslint-disable object-curly-spacing */
/**
 * Platform-owned proxy egress for webrain calls.
 *
 * Why the pool is server-side and the client never picks
 * -----------------------------------------------------
 * A caller-chosen proxy means the caller chooses where OUR request is made
 * from. They can then read everything that crosses it, including any credential
 * we attach, and any abuse is attributed to an endpoint they control. So the
 * route handlers strip a `proxy` field and this module drops it again at the
 * single point every tool call passes through -- two lines, because the failure
 * of forgetting one is not a bug you notice.
 *
 * Why the logic lives in `domain/`
 * -------------------------------
 * This file imports nothing but the tier resolver, so a spec can import it and
 * test behaviour. The same logic inside `webrain-mcp.ts` would drag in the
 * Firebase Admin app and a Secret Manager client at module load, which is why
 * the BYOK spec next door can only assert on source shape. Pure functions here
 * are testable for free; that is the whole reason for the split.
 *
 * Supply is deliberately not this module's business: the pool arrives as an
 * argument, resolved per call by `infrastructure/webrain-config.store.ts`, so
 * managed-residential versus self-run VPS stays a config decision and this file
 * keeps importing nothing that would drag I/O into a spec.
 */

import {webrainTierFor} from "./webrain-tools.domain"

/**
 * Tools whose worker schema actually accepts a `proxy` argument.
 *
 * An allowlist rather than "inject everywhere": the worker's tools do not share
 * one argument surface, and an argument a tool does not declare is at best
 * ignored and at worst a rejected call. `webrain_navigate` and friends also
 * take a proxy, but they are paid-only and their proxy is fixed at browser
 * launch, so rotation cannot move it per request anyway.
 */
const PROXY_CAPABLE: ReadonlySet<string> = new Set([
  "webrain_serp",
  "webrain_search",
])

/**
 * How many pool entries a free caller is served from.
 *
 * The ceiling is the cost control, not the index: one entry means a free
 * caller's traffic is pinned to a single exit, which is both cheaper to reason
 * about reputationally and easy to cap or disable without touching the paid
 * path. Paid callers spread across the whole list.
 */
const FREE_POOL_SIZE = 1

/**
 * One usable proxy exit: the worker gets `url`, an operator reads `label`.
 *
 * The label never carries credentials. Deriving one is the resolver's job, and
 * a malformed entry there falls back to its position rather than to the raw
 * string, which is the one place a `user:pass` could otherwise reach a log.
 */
export interface ProxyEntry {
  label: string
  url: string
}

/**
 * Whether a tool can be handed a proxy at all.
 * @param {string} tool The MCP tool name.
 * @return {boolean} True when the worker schema declares `proxy`.
 */
export const proxyCapable = (tool: string): boolean => PROXY_CAPABLE.has(tool)

/**
 * One entry from the tier's slice of the pool, or undefined when it is empty.
 *
 * The pool is an ARGUMENT rather than an env read: this module must import
 * nothing with I/O or the spec next door cannot import it, and resolution has
 * to happen per call so a rotation is visible without a redeploy.
 *
 * Random rather than round-robin: rotation without shared state, and this
 * process is not the only caller. An empty pool degrades to "no proxy" and the
 * request goes out on our own address, which is the pre-existing behaviour.
 * ponytail: random can repeat within a burst. Add a per-process cursor if
 * per-exit distribution ever matters for rate limits.
 * @param {string|undefined} accessMode The resolved entitlement.
 * @param {ProxyEntry[]} pool The resolved pool, already normalised.
 * @return {ProxyEntry|undefined} An exit, or undefined when none is usable.
 */
export const pickProxy = (
  accessMode: string | undefined,
  pool: ProxyEntry[]
): ProxyEntry | undefined => {
  if (pool.length === 0) {
    return undefined
  }

  const tier = webrainTierFor(accessMode)
  const cap = tier === "free" ?
    Math.min(FREE_POOL_SIZE, pool.length) :
    pool.length

  return pool[Math.floor(Math.random() * cap)]
}

/**
 * Strip any caller-supplied proxy and attach the platform's.
 *
 * Used at the one place every tool call is built, so no caller can reach the
 * worker with an egress of their own choosing and no future tool can forget to
 * opt in.
 * @param {string} tool The MCP tool name.
 * @param {string|undefined} accessMode The resolved entitlement.
 * @param {Record<string, unknown>} args The caller's arguments.
 * @param {ProxyEntry[]} pool The resolved pool, already normalised.
 * @return {Record<string, unknown>} Arguments with platform egress applied.
 */
export const withPlatformProxy = (
  tool: string,
  accessMode: string | undefined,
  args: Record<string, unknown>,
  pool: ProxyEntry[]
): Record<string, unknown> => {
  // Dropped unconditionally, capable tool or not. Egress is platform-owned, so
  // a caller-supplied proxy is never forwarded to the worker whether the tool
  // would have honoured it or not -- one rule with no exceptions, rather than a
  // rule that depends on the reader knowing which tools declare the argument.
  // Dropped and not merely overwritten when the pool is empty, too: honouring a
  // caller's proxy because we have none of our own would invert the rule at the
  // exact moment it matters.
  const rest = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== "proxy")
  )

  if (!proxyCapable(tool)) {
    return rest
  }

  const entry = pickProxy(accessMode, pool)
  return entry ? {...rest, proxy: entry.url} : rest
}
