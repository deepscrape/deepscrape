/* eslint-disable object-curly-spacing */
/**
 * QStash: publish a crawl target, and verify a delivery.
 *
 * Why this exists
 * ---------------
 * `webrainJobs.multiCrawlEnqueue` ran the whole batch inline before responding,
 * so a job was terminal the moment its id was handed out and `In Progress` was
 * unreachable by construction. The dashboard has consumed non-final statuses
 * since it was written (`operations.component.ts` refreshes on `!s.final`), so
 * this is the missing half of a feature that already exists on the client.
 *
 * One message per target, not per job
 * -----------------------------------
 * The two are the same size to write. Per-target is correct on the edge case
 * that matters: a 50-target job in a single delivery holds one concurrency slot
 * for the whole batch (head-of-line blocking against a shared pool) and races
 * the platform request timeout, where 50 messages interleave and retry
 * individually.
 *
 * Why the SDK rather than `fetch` + `node:crypto`
 * -----------------------------------------------
 * Publishing is one HTTP call and `fetch` would do it. Verification is not.
 * `Upstash-Signature` is a JWS whose claims — `iss`, `sub`, `exp`, `nbf` and
 * the body hash — must all be checked, against BOTH signing keys during a
 * rotation window. That is a trust boundary, and hand-rolled base64url/JWT
 * parsing is precisely where a permissive bug hides. The dependency earns its
 * place on the verifier alone.
 */
import { Client, Receiver } from "@upstash/qstash"
import { DEFAULT_APP_ORIGIN, env } from "../config/env"
import { webrainWorkerPool } from "./webrain-config.store"

/**
 * The payload of one queued crawl target.
 *
 * A reference, never the scraped result: the result belongs in Firestore, and a
 * large body would be copied through a third party and signed along with it.
 */
export interface CrawlTargetMessage {
  /** The job this target belongs to. */
  taskId: string
  /** The owner, carried so the worker need not trust anything else. */
  uid: string
  /** One already-validated target. */
  url: string
  /**
   * The entitlement resolved when the job was queued.
   *
   * Carried rather than re-derived so the worker does not re-read the billing
   * document per target, and safe to carry because only a signature-verified
   * delivery is ever trusted.
   */
  accessMode?: string
}

/**
 * Whether the queue is configured.
 *
 * Read per call rather than frozen at import, so adding the two env vars to a
 * deployment takes effect without a code change.
 * @return {*} True when both the token and the URL are set.
 */
export const qstashConfigured = (): boolean =>
  Boolean(env.QSTASH_TOKEN && env.QSTASH_URL)

/**
 * Builds a job-endpoint URL from an origin.
 *
 * Split out because the trailing-slash handling is the only branchy part, and a
 * doubled slash is a 404 rather than an obvious error.
 * @param {string} origin The app origin, with or without a trailing slash.
 * @param {string} leaf The endpoint name.
 * @return {*} The absolute URL.
 */
export const jobUrlFor = (origin: string, leaf: string): string =>
  `${origin.replace(/\/+$/, "")}/api/jobs/crawl/${leaf}`

/**
 * The delivery target for one target's work.
 * @param {string} origin The app origin.
 * @return {*} The absolute worker URL.
 */
export const workerUrlFor = (origin: string): string =>
  jobUrlFor(origin, "worker")

/**
 * Where QStash reports a message whose retries are exhausted.
 * @param {string} origin The app origin.
 * @return {*} The absolute failure URL.
 */
export const failureUrlFor = (origin: string): string =>
  jobUrlFor(origin, "failed")

/**
 * Where QStash delivers.
 *
 * Derived from `APP_ORIGIN`, which already names the authenticated app's
 * origin, so there is no second origin to keep in sync.
 *
 * ponytail: local `qstash-cli dev` delivers from the same machine, so an
 * `APP_ORIGIN` of `http://127.0.0.1:8080` works and no local-only branch is
 * needed.
 * @return {*} The absolute worker URL.
 */
export const workerUrl = (): string => workerUrlFor(env.APP_ORIGIN)

/**
 * Where QStash reports a target whose retries are exhausted.
 *
 * Without this, a target that never lands leaves the job short of its total and
 * `deriveStatus` reports `In Progress` for ever — a job that is neither running
 * nor finished, and that no amount of refreshing resolves.
 * @return {*} The absolute failure URL.
 */
export const failureUrl = (): string => failureUrlFor(env.APP_ORIGIN)

/**
 * Whether publishing here would enqueue work for the DEPLOYED platform.
 *
 * `APP_ORIGIN` defaults to the production app because an email link must be
 * absolute — correct for a deployment, wrong for a laptop. A local batch with
 * a real `QSTASH_TOKEN` would otherwise ask the queue to crawl against
 * production, carrying the local caller's uid, and it would SUCCEED: nothing on
 * the publish path can tell you it did the wrong thing.
 * @param {string} origin The origin the worker URL is built from.
 * @param {boolean} isProduction Whether this process is the deployment.
 * @return {boolean} True when the target would be delivered to production.
 */
export const queueTargetsProduction = (
  origin: string,
  isProduction: boolean
): boolean =>
  !isProduction && origin.replace(/\/+$/, "") === DEFAULT_APP_ORIGIN

/**
 * Publishes one target to the queue.
 *
 * `retries` is explicit rather than left to the default: three attempts is the
 * intended budget for a transient worker failure, and a silent default change
 * would alter billing behaviour without any code changing.
 * @param {CrawlTargetMessage} message The target to queue.
 * @return {*} The QStash message id — also the billing idempotency key, and
 * stable across a retry, which is what makes it usable as one.
 */
export async function publishCrawlTarget(
  message: CrawlTargetMessage
): Promise<string> {
  if (queueTargetsProduction(env.APP_ORIGIN, env.IS_PRODUCTION)) {
    throw new Error(
      "Refusing to queue a crawl target for the production origin from a " +
        "non-production process. Set APP_ORIGIN to this machine's address."
    )
  }
  const response = await new Client({
    token: env.QSTASH_TOKEN,
    baseUrl: env.QSTASH_URL,
  }).publishJSON({
    url: workerUrl(),
    body: message,
    retries: 3,
    failureCallback: failureUrl(),
    flowControl: {
      key: FLOW_CONTROL_KEY,
      parallelism: await crawlParallelism(),
    },
  })
  return response.messageId
}

/**
 * The flow-control key every crawl delivery shares.
 *
 * ONE key for the whole platform rather than one per tenant, and the choice is
 * the whole point of the setting: the scarce resource is the shared worker
 * pool, so the ceiling has to be global. A per-tenant key would cap each
 * tenant's concurrency while letting the TOTAL run unbounded into a pool that
 * cannot serve it -- and the refusals that follow are each retried three times,
 * which amplifies the load that caused them.
 */
export const FLOW_CONTROL_KEY = "webrain-pool"

/**
 * The concurrency ceiling for a pool of `workerCount` workers.
 *
 * A lease on a pool worker is EXCLUSIVE and a slot is held for the length of
 * the call, so the number of workers IS the number of calls the pool can serve
 * at once. That is why this is derived from the pool rather than configured:
 * a ceiling set ABOVE the real one does not queue politely, it earns a refusal
 * per excess call, and each of those burns three retries.
 *
 * Floored at 1 because QStash reads a `parallelism` of **0 as unlimited**,
 * which is the exact opposite of the intent -- so an empty or unparseable pool
 * must not silently uncap delivery concurrency.
 * @param {number} workerCount How many workers the pool currently resolves to.
 * @return {*} A parallelism of at least 1.
 */
export const parallelismFor = (workerCount: number): number =>
  Number.isFinite(workerCount) && workerCount >= 1 ?
    Math.floor(workerCount) :
    1

/**
 * The concurrency ceiling to publish with, from the live pool.
 *
 * Read per delivery rather than frozen at import so a pool resize takes effect
 * without a deploy. The store caches the underlying secret read, so this is not
 * a Firestore round trip per message.
 *
 * `rate`/`period` are deliberately NOT set. They would cap how fast messages
 * ACTIVATE, which is a different property from how many may be in flight, and
 * a fixed activation rate throttles a fast pool below the capacity its size
 * already licenses -- the pool ceiling is a concurrency fact and this is the
 * only field that expresses it.
 * @return {*} The parallelism for the next publish.
 */
export const crawlParallelism = async (): Promise<number> =>
  parallelismFor((await webrainWorkerPool()).length)

/**
 * Verifies a delivery's signature, accepting either signing key.
 *
 * Both keys are supplied because QStash rotates them: verifying against only
 * the current one rejects every in-flight delivery as a forgery during the
 * rotation window.
 *
 * `rawBody` must be the bytes as received. A re-stringified `JSON.parse` is NOT
 * equivalent — the signature covers the exact body — which is why this takes a
 * string and never an object. `stripe.ts` already relies on `req.rawBody` for
 * the same reason.
 * @param {string} rawBody The request body, byte-exact.
 * @param {string} signature The `Upstash-Signature` header.
 * @param {string} url The full URL the request was delivered to.
 * @return {*} True only when the signature verifies.
 */
export async function verifyQstashDelivery(
  rawBody: string,
  signature: string,
  url: string
): Promise<boolean> {
  if (!signature || !env.QSTASH_CURRENT_SIGNING_KEY) {
    return false
  }

  const receiver = new Receiver({
    currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
  })

  try {
    return await receiver.verify({ signature, body: rawBody, url })
  } catch {
    // A malformed signature throws rather than returning false. Both outcomes
    // mean "not from QStash", and a caller that could tell them apart would
    // learn which half of a forgery attempt was wrong.
    return false
  }
}
