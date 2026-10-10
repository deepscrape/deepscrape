/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The degradation signals webrain attaches to a tool payload.
 *
 * Why this is a domain module and not part of the client
 * -----------------------------------------------------
 * The same reason `webrain-proxy.domain.ts` exists. `infrastructure/webrain-mcp.ts`
 * imports `webrain-config.store`, which builds the Firebase Admin app at module
 * load, so anything defined there cannot be imported by a spec — which is how a
 * parsing rule ends up asserted on source shape instead of on behaviour. These
 * are pure functions over an already-parsed payload, so a spec can pin them
 * against payloads captured from a running engine.
 *
 * What the signal is for
 * ---------------------
 * `webrain_scrape` — which is `POST /api/scrape`, a free, live route — fetches
 * over plain HTTP with **no browser** and reports whether the page turned out to
 * be a JavaScript shell. A `true` means the caller received that shell rather
 * than content: the page needs an engine that runs JavaScript. Until this
 * module nothing read it, so a scrape that returned an empty shell was
 * indistinguishable from one that worked.
 *
 * That is the difference between "the free tier is fine" and "the free tier
 * silently returns nothing on any JS page", and it is the only signal that can
 * decide whether a browser-backed path is needed for a given request.
 *
 * Verified against a real engine, not inferred (2026-10-02)
 * --------------------------------------------------------
 * Captured from `webrain mcp --http 9224` and a local static server:
 *
 *   https://example.com  -> {"result":{"needs_js":false,"visible_chars":425},…}
 *   a 111-byte JS shell  -> {"result":{"needs_js":true, "visible_chars":3},  …}
 *
 * Two things to keep: the flags are nested under `result`, not top-level; and
 * the heuristic is webrain's (`probe_needs_js`) — JS-required markers, or an
 * HTML shell with almost no visible text. It is a heuristic, so a `false` is not
 * proof that content arrived.
 */

/**
 * A parsed JSON object, or undefined for anything that is not one.
 *
 * Arrays are deliberately excluded: `typeof [] === "object"`, and treating one
 * as a record would let a list-shaped payload answer with its own properties.
 * @param {unknown} value The value to narrow.
 * @return {Record<string, unknown> | undefined} The record, or undefined.
 */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ?
    (value as Record<string, unknown>) :
    undefined

/** What webrain said about one payload, when it said anything at all. */
export interface WebrainPayloadSignals {
  /**
   * True when the page is a JS shell and the browserless fetch returned no
   * content. **Omitted, not false, when the tool does not report it** — see
   * `webrainPayloadSignals`.
   */
  needsJs?: boolean
  /** Visible characters; the heuristic's other input, kept for context. */
  visibleChars?: number
}

/**
 * Read the degradation signals out of a parsed tool payload.
 *
 * **Absent is not the same as false and the two are kept apart.** Only the
 * browserless fetch nests a `result` object carrying these keys; `extract`,
 * `pdf` and `serp` do not report them at all. Defaulting to `false` would make
 * every tool that says nothing look like a static page that fetched cleanly,
 * which is the exact confusion this exists to remove — so a caller must treat
 * `undefined` as "no information", never as "all good".
 *
 * Validated rather than cast, for the same reason the session store validates
 * what it reads: the payload comes from another process, and an older or
 * hand-edited worker must not be able to turn a string into a truthy signal.
 * @param {unknown} json The parsed payload, or anything else.
 * @return {WebrainPayloadSignals} The signals, each omitted when absent.
 */
export const webrainPayloadSignals = (
  json: unknown,
): WebrainPayloadSignals => {
  const result = asRecord(asRecord(json)?.result)
  const signals: WebrainPayloadSignals = {}

  const needsJs = result?.needs_js
  if (typeof needsJs === "boolean") {
    signals.needsJs = needsJs
  }

  const visibleChars = result?.visible_chars
  if (typeof visibleChars === "number" && Number.isFinite(visibleChars)) {
    signals.visibleChars = visibleChars
  }

  return signals
}
