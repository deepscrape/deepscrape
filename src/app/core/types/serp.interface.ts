/**
 * The SERP surface of the webrain engine.
 *
 * Derived field-for-field from `webrain-core/src/serp.rs` — `SerpResult`,
 * `SerpResponse`, `SerpEngineReport` and `SerpOpts` — not from a guess at what
 * a search API usually looks like. That matters for two reasons:
 *
 *  1. Three fields are `#[serde(skip_serializing_if = ...)]` on the Rust side,
 *     so they are ABSENT from the wire when empty, not null and not `[]`. They
 *     are optional here for that reason. Typing them as required would produce
 *     `undefined` at the first `per_engine.length` and crash a view that had
 *     passed review.
 *  2. The value ranges are the engine's, not ours: `limit` is 1..=100 and
 *     `page` is 0-based. The UI must not offer a 200-result page the engine
 *     will refuse.
 *
 * webrain exposes three search paths — `http_search` (browserless, the cheap
 * one), `browser_search` (a real browser, needed for engines that will not
 * answer over HTTP) and `serp_search` (the multi-engine aggregator). `engine`
 * selects between them, and `auto` is the aggregator: it queries the HTTP
 * engines and merges, which is why it reports `per_engine`.
 */

/**
 * Which engine answers.
 *
 * `auto` merges every HTTP engine and is the only value that guarantees
 * `per_engine` is populated. `google` and `brave` need an attached browser —
 * without one they are reported as `skipped` rather than failing the request.
 */
export type SerpEngine = 'duckduckgo' | 'bing' | 'google' | 'brave' | 'auto';

/**
 * One engine's outcome inside a reply.
 *
 * `empty` and `skipped` are distinct and the difference is worth surfacing:
 * `empty` means the engine answered with nothing relevant, `skipped` means it
 * never answered at all (error, timeout, or no browser attached). Showing both
 * as "no results" hides a configuration problem behind a content problem.
 */
export type SerpEngineStatus = 'ok' | 'empty' | 'skipped';

/** One typed organic result. */
export interface SerpResult {
  /** 1-based rank within the returned list. */
  position: number;
  title: string;
  url: string;
  /** Registrable-ish host with `www.` stripped. */
  domain: string;
  snippet: string;
}

/** One engine's contribution to a reply. */
export interface SerpEngineReport {
  engine: string;
  /** `ok` contributed at least one relevant result. */
  status: SerpEngineStatus;
  /** How many results this engine contributed, after relevance filtering. */
  count: number;
}

/** The full reply envelope. */
export interface SerpResponse {
  query: string;
  /** The engine actually used; `auto` resolves to the first non-empty. */
  engine: string;
  results: SerpResult[];
  /** Opaque id for correlating a reply across retries and logs. */
  request_id: string;
  /** Wall-clock time for the whole request including fallout, in ms. */
  ms: number;
  /**
   * Engines that returned zero relevant results or errored, and were skipped.
   *
   * Absent rather than empty when there are none.
   */
  skipped?: string[];
  /**
   * The provider that actually supplied the results, which differs from
   * `engine` only after a fallback (engine=google, source=duckduckgo).
   *
   * Absent rather than empty for `auto`, whose reply is a merged aggregate.
   */
  source?: string;
  /**
   * Per-engine breakdown, always populated for `auto`; a single-engine call
   * reports only the winner plus any skipped fallbacks.
   *
   * Absent rather than empty when there is nothing to report.
   */
  per_engine?: SerpEngineReport[];
}

/**
 * What the UI sends.
 *
 * A deliberate subset of the engine's `SerpOpts`. The three omitted fields are
 * omitted on purpose, not forgotten:
 *
 *  - `retries` and `fallback` are resilience policy that belongs to the server,
 *    so a caller cannot disable retries and quietly make every flaky search a
 *    user-visible failure.
 *  - `proxy` is operator configuration. A caller choosing their own proxy would
 *    be routing platform traffic through an egress point nobody vetted.
 */
export interface SerpRequest {
  query: string;
  engine?: SerpEngine;
  /** 1..=100. The engine refuses anything outside that range. */
  limit?: number;
  /** 0-based page index. */
  page?: number;
  safe?: boolean;
  /** Locale, shaped `us-en`, `gb-en`, `gr-el`, `de-de`. */
  region?: string;
  /**
   * Whether the worker may attach or launch a browser for this search.
   *
   * Omitted is NOT the same as `false` in intent — it defers to the worker's
   * own default, which is browserless. That is deliberate: the cheap path is
   * the default, so a caller who wants depth opts IN rather than paying for a
   * guest Chrome on every search.
   *
   * `true` only changes `bing` today. `google` and `brave` are JS-gated and
   * drive a browser whether or not this is set; `duckduckgo` has no browser
   * path yet, so for both an explicit value is inert.
   */
  browser?: boolean;
}

/**
 * Defaults for a new search, mirroring `SerpOpts::default()` where it matters
 * to the UI.
 *
 * `auto` rather than a single engine because the UI has no way to know which
 * engine will answer for a given query, and `auto` degrades by merging instead
 * of returning nothing.
 */
export const SERP_DEFAULTS: Required<Pick<SerpRequest, 'engine' | 'limit' | 'page' | 'safe'>> = {
  engine: 'auto',
  limit: 10,
  page: 0,
  safe: true,
};

/** The engine's own bounds, so the UI cannot offer an invalid one. */
export const SERP_LIMITS = {
  minLimit: 1,
  maxLimit: 100,
} as const

/**
 * The BFF route's own envelope, which is NOT the engine's.
 *
 * `POST /api/serp` wraps the engine reply:
 *
 *   { provider: "webrain", status: "ok",    query, data: <SerpResponse>, tokens?, ms? }
 *   { provider: "webrain", status: "error", query?, error, refusal?, transportError? }
 *
 * `data` is the engine payload passed through unchanged (see
 * `functions/src/handlers/serp.ts`), which is why the two shapes are kept apart
 * here rather than flattened into one. Flattening would put `results` on an
 * error reply as an absent field and invite `envelope.results.length` on a 403.
 *
 * Note the route answers a refusal (403) and an outage (502) with HTTP error
 * statuses, so the error branch normally arrives as an `HttpErrorResponse`
 * body rather than as a 200 carrying `status: "error"`. Both are modelled, so
 * a proxy that rewrites the status cannot turn a failure into an empty success.
 */
export interface SerpErrorEnvelope {
  provider: string
  status: 'error'
  error: string
  query?: string
  /** Why the tool was withheld, when the refusal came from the tier allowlist. */
  refusal?: string
  /** Set when the worker could not be reached at all, as opposed to refusing. */
  transportError?: boolean
}

/** A successful reply: `data` carries the engine's own `SerpResponse`. */
export interface SerpOkEnvelope {
  provider: string
  status: 'ok'
  query: string
  data: SerpResponse
  tokens?: number
  ms?: number
}

/** Either branch of the route reply, discriminated on `status`. */
export type SerpEnvelope = SerpOkEnvelope | SerpErrorEnvelope

/**
 * Display names for the engine vocabulary, so the picker is not five words in
 * a language the UI does not otherwise speak.
 *
 * Keyed by `SerpEngine` rather than listed, so adding an engine to the union
 * fails the type check here instead of silently rendering an empty option.
 */
export const SERP_ENGINE_OPTIONS: readonly { name: string; code: SerpEngine }[] = [
  { name: 'SEARCH.ENGINE_AUTO', code: 'auto' },
  { name: 'SEARCH.ENGINE_DUCKDUCKGO', code: 'duckduckgo' },
  { name: 'SEARCH.ENGINE_BING', code: 'bing' },
  { name: 'SEARCH.ENGINE_GOOGLE', code: 'google' },
  { name: 'SEARCH.ENGINE_BRAVE', code: 'brave' },
];
