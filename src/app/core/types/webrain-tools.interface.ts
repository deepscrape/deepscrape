/**
 * The three free-tier webrain tool routes, as the playground consumes them.
 *
 * One envelope for all three
 * -------------------------
 * `functions/src/handlers/webrain-tools.ts` answers every one of these routes
 * through a single `runRoute` tail, so the shape is identical apart from the
 * correlation field, which is named after the argument (`query` for search,
 * `mode` for extract, `op` for pdf). That field is deliberately NOT modelled as
 * a named property: typing it three ways would mean three interfaces that
 * differ only in a key nobody reads.
 *
 * `data` is `unknown` on purpose
 * -----------------------------
 * The worker's own payload is the contract -- the handler passes it through
 * unchanged rather than re-modelling it, and says so. Naming its fields here
 * would be the drift that comment exists to prevent, so the panel renders it as
 * JSON and this file refuses to pretend it knows the shape.
 */

/** The correlation field each route echoes, for showing "what was asked". */
export type ToolEchoField = 'query' | 'mode' | 'op';

/** What the panel sends. Argument names are the HTTP surface's, not the worker's. */
export type ToolRequestBody = Record<string, unknown>;

/** A reply from any of the three routes, success or failure, in one shape. */
export interface ToolEnvelope {
  /** `webrain` on a tool answer; absent on the 400 the mappers produce. */
  readonly provider?: string;
  /** `ok` or `error`; absent on a 400 from the argument mapper. */
  readonly status?: string;
  /** The worker's payload, unmodified, when `status` is `ok`. */
  readonly data?: unknown;
  /** The refusal or failure text, when `status` is `error`. */
  readonly error?: string;
  /** Worker-reported token count, when it reported one. */
  readonly tokens?: number;
  /** Worker-reported elapsed milliseconds, when it reported one. */
  readonly ms?: number;
  /** `true` when the worker could not be reached at all, i.e. a retry may help. */
  readonly transportError?: boolean;
}

/**
 * What `POST /api/extract/schema` answers.
 *
 * A separate envelope from `ToolEnvelope` rather than a variant of it, and the
 * distinction is the point. The compiler answers THIS gateway's contract -- a
 * schema it has already executed and proved yields rows -- not the worker's
 * payload. So naming its fields here is correct, where naming the worker's would
 * be the drift the header above warns about.
 *
 * `rows` and `sample_rows` are what make it trustworthy before it is saved: a
 * schema that parses but selects nothing is a 422, never a 200 with an empty
 * array, so a caller who sees rows has seen it work.
 */
export interface SchemaCompileResult {
  readonly url?: string;
  readonly intent?: string;
  readonly model?: string;
  /** `true` when a schema was compiled AND proved to select something. */
  readonly ok?: boolean;
  /** What to store and execute -- see `CompiledSchema`. */
  readonly schema?: CompiledSchema;
  /** Records the schema selected on the page it was compiled against. */
  readonly rows?: number;
  /** The first few rows, so a human sees the column names before saving. */
  readonly sample_rows?: Record<string, unknown>[];
  /** `1` when it compiled first time, `2` when the retry was needed. */
  readonly attempts?: number;
  /** Why it failed, when `ok` is false; or the HTTP failure text. */
  readonly error?: string;
}

/**
 * A compiled schema, in crawl4ai's `JsonCssExtractionStrategy` shape.
 *
 * `baseSelector` is camelCase and an attribute is `type: "attribute"` with an
 * `attribute` key -- the vocabulary `crawl.interface.ts` declares, and the one a
 * schema pasted from crawlagent already uses. So this drops into a pack as
 * `{ extractionStrategy: { schema } }` and is interchangeable with a
 * hand-written schema rather than being a private dialect.
 *
 * The worker's own argument names (`base_selector`, `attr`) are a boundary
 * concern and are converted in the compiler's `toWorkerArgs`; nothing here or in
 * a stored pack should know them.
 */
export interface CompiledSchema {
  /** Optional schema name -- crawl4ai's key. */
  readonly name?: string;
  /** CSS selecting every record. */
  readonly baseSelector: string;
  /** The columns, each selected INSIDE one record. */
  readonly fields: Record<string, unknown>[];
}
