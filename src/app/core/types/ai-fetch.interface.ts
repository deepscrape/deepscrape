/**
 * The `/api/scrape` reply, as the AI pipeline consumes it.
 *
 * Why this is narrower than `SerpEnvelope`
 * ---------------------------------------
 * `SerpEnvelope` models `POST /api/serp`, whose `data` carries the engine's own
 * typed `SerpResponse`. `/api/scrape` wraps a DIFFERENT payload: the worker
 * answers `{"status":"ok","result":{url,status,content_type,text,bytes}}` (see
 * `functions/src/domain/monitors.domain.spec.ts`, which asserts that literal
 * shape). One envelope type covering both would have to widen `data` to
 * `unknown` and hand every caller a cast.
 *
 * Two shapes, not one, for the same reason the route table keeps them apart
 * ---------------------------------------------------------------------
 * `webrain_scrape` answers its result under `result`, while `webrain_search`
 * and `webrain_extract` answer it at the top level (see the header of
 * `functions/src/handlers/webrain-tools.ts`). So `WebrainScrapePayload` has a
 * `result` member and nothing else pretends to.
 *
 * The error branch is a real HTTP status, not a 200
 * ------------------------------------------------
 * The route answers 400 for a refused argument, 401 without a token, 403 when
 * the tier allowlist withholds the tool, and 502 when the worker fails. So the
 * error branch normally arrives as an `HttpErrorResponse` body rather than as a
 * 200 carrying `status: "error"`. Both are modelled here, so a proxy that
 * rewrites the status cannot turn a failure into an empty success.
 */

/** The worker's own `webrain_scrape` result. */
export interface WebrainScrapeResult {
  url: string;
  /** The HTTP status the WORKER saw for the target, not this route's status. */
  status: number;
  content_type: string;
  /** The page body as text. This is what the AI pipeline forwards to a model. */
  text: string;
  bytes: number;
}

/** The worker's own payload: `{"status":"ok","result":{...}}`. */
export interface WebrainScrapePayload {
  status: 'ok';
  result: WebrainScrapeResult;
}

/**
 * The route's wrapper around the worker payload.
 *
 * `url` is the field the route echoes back for correlation, already validated
 * by the platform's target guard.
 */
export interface WebrainScrapeOkEnvelope {
  provider: string;
  status: 'ok';
  url: string;
  data: WebrainScrapePayload;
  tokens?: number;
  ms?: number;
}

/**
 * The route's failure reply.
 *
 * `refusal` is set when the tool was withheld by the tier allowlist, and
 * `transportError` when the worker could not be reached at all. They are kept
 * apart because the remedy differs: a refusal is a plan question, an outage is
 * a retry.
 */
export interface WebrainScrapeErrorEnvelope {
  provider: string;
  status: 'error';
  error: string;
  url?: string;
  refusal?: string;
  transportError?: boolean;
}

/** Either branch of the route reply, discriminated on `status`. */
export type WebrainScrapeEnvelope = WebrainScrapeOkEnvelope | WebrainScrapeErrorEnvelope;

/**
 * The page content a fetch produced, or the reason it produced none.
 *
 * The pipeline's own type rather than the envelope, so a consumer never has to
 * know which of the two reply shapes it was handed, and so the "no text" case
 * is a stated outcome instead of an empty string that renders as a blank panel.
 */
export interface WebrainFetchedPage {
  url: string;
  /** The worker's text body. Empty when the worker returned none. */
  text: string;
  contentType: string;
  /** The HTTP status the worker saw for the target. */
  status: number;
  bytes: number;
  tokens?: number;
  ms?: number;
}
