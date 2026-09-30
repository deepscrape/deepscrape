/* eslint-disable object-curly-spacing */
/**
 * Provider selection for the scrape route, plus the webrain implementation of
 * it.
 *
 * Why this file exists
 * -------------------
 * `/api/crawl` used to have exactly one implementation (`crawl4aiCore`, which
 * dials crawlagent). The platform now has three providers — `crawl4ai`, `jina`
 * and `webrain` — so the route needs a seam that names a provider instead of
 * hardcoding one, which is what
 * `docs/ADR-2026-09-CRAWL-PROVIDER-ABSTRACTION.md`
 * §4 calls for. This is the smallest version of that seam: one selector, one
 * second implementation.
 *
 * Selection is NOT the caller's to make directly. The client never names an
 * egress; the platform resolves one from the catalogue in
 * `domain/scrape-providers.domain.ts` and the user's stored preference in
 * `infrastructure/scrape-provider.store.ts`, gated by their access mode. A
 * request
 * therefore cannot choose its own worker, which is the rule the whole gateway
 * design rests on.
 */
import { Request, Response } from "express"
import { crawl4aiCore } from "./ai_handler"
import { webrainTool } from "../infrastructure/webrain-mcp"
import { safeTargetUrls } from "../domain/url-guard.domain"
import { resolveProvider } from "../domain/scrape-providers.domain"
import { readStoredProvider } from "../infrastructure/scrape-provider.store"

/**
 * One target's outcome from `webrain_scrape`, flattened for the response.
 *
 * `url` is echoed back so a partial batch is still attributable to the target
 * that
 * failed, and `data` is the worker's typed JSON passed through unchanged rather
 * than raw markup.
 */
interface WebrainScrapeResult {
  url: string
  ok: boolean
  /**
   * The worker's own typed JSON, passed through unchanged.
   *
   * This is the plan's "return typed JSON, never raw markup" rule: the
   * payload
   * is whatever `webrain_scrape` produced, not a blob we re-shape here. A
   * gate is
   * read out of it structurally, so a provider that reports one differently
   * still
   * surfaces the state.
   */
  data?: unknown
  /**
   * Anti-bot gate, when the tool reports one, else null.
   *
   * `webrain_scrape` is a plain-HTTP fetch and carries no `challenge` field
   * at
   * all — that signal belongs to `webrain_navigate` / `observe(what=state)` /
   * `search` (webrain-core/src/browser.rs:23, emitted at
   * tools.rs:948/1244/1926).
   * It is read here rather than assumed, so switching this handler to a
   * browser-backed tool starts reporting gates with no change to the UI.
   */
  challenge: string | null
  /** Response size stamp — an estimate, and the basis
   * for per-tenant accounting. */
  tokens?: { chars?: number; est_tokens?: number }
  ms?: number
  error?: string
  /** The shared worker refused this tool because it is stateful. */
  noStateRefused?: boolean
  /** The worker could not be reached, or `WEBRAIN_MCP_URL` is unset. */
  transportError?: boolean
}

/** Reads `challenge` out of whatever shape the tool returned.
 * @param {*} data
 * @return {*}
 */
const challengeOf = (data: unknown): string | null => {
  if (!data || typeof data !== "object") {
    return null
  }
  const value = (data as Record<string, unknown>)["challenge"]
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * `/api/crawl`, served by webrain.
 *
 * Same request body as the crawl4ai path (`{urls}`) and the same guard, so the
 * Angular caller does not need to know which provider answered — only the
 * `provider` field in the response says so. Deliberately sequential rather than
 * parallel: the shared free-tier pool caps concurrency, and firing N tools at
 * once
 * is how one tenant starves the others (webrain's own per-call clamp is 6 under
 * `WEBRAIN_NO_STATE`, which is a per-call value, not an aggregate limit).
 * @param {*} req
 * @param {*} res
 */
export const webrainCrawl = async (
  req: Request,
  res: Response
): Promise<void> => {
  const safeUrls = safeTargetUrls(
    (req.body as { urls?: unknown } | undefined)?.urls
  )

  if (!safeUrls.length) {
    res.status(400).json({ error: "Invalid target URLs" })
    return
  }

  const results: WebrainScrapeResult[] = []

  for (const url of safeUrls) {
    const call = await webrainTool("webrain_scrape", req.accessMode, { url })
    results.push({
      url,
      ok: call.ok,
      data: call.json,
      challenge: challengeOf(call.json),
      tokens: call.tokens,
      ms: call.ms,
      error: call.error,
      noStateRefused: call.noStateRefused,
      transportError: call.transportError,
    })
  }

  const failed = results.filter((result) => !result.ok).length

  res.status(failed === results.length ? 502 : 200).json({
    provider: "webrain",
    status:
      failed === 0 ? "ok" : failed === results.length ? "error" : "partial",
    count: results.length,
    failed,
    results,
  })
}

/**
 * The handler `/api/crawl` should be registered with.
 *
 * Resolves the provider per request: the caller's stored preference when their
 * plan entitles them to it and that provider serves this route, otherwise the
 * platform default. A two-argument function, which TypeScript accepts wherever
 * a
 * three-argument Express middleware is expected, so both route tables can use
 * it
 * unchanged.
 *
 * The resolution is reported in response headers rather than kept private. A
 * user
 * whose stored choice was refused needs to see that it was refused — silently
 * downgrading is how someone concludes the product ignored their setting — and
 * a
 * server log nobody reads is not a way to tell them.
 * @param {*} req
 * @param {*} res
 */
export const scrapeMiddleware = async (
  req: Request,
  res: Response
): Promise<void> => {
  const uid = req.user?.uid
  const stored = uid ? await readStoredProvider(uid) : undefined
  const resolution = resolveProvider(stored, req.accessMode)

  res.setHeader("x-scrape-provider", resolution.provider)
  res.setHeader("x-scrape-provider-source", resolution.source)
  if (resolution.rejected) {
    res.setHeader("x-scrape-provider-rejected", resolution.rejected.reason)
  }

  if (resolution.provider === "webrain") {
    await webrainCrawl(req, res)
    return
  }

  await crawl4aiCore(req, res)
}
