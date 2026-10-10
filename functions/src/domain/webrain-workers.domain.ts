/* eslint-disable object-curly-spacing */
/**
 * The browser-worker pool: which worker a call may use, and when it may not.
 *
 * What a lease is
 * ---------------
 * A dedicated session leases a machine. A free playground call does not: it
 * runs against a webrain worker over MCP, so its unit of capacity is a worker
 * held for one call and released after it, not a Fly machine held for minutes.
 *
 * Exclusivity is the safety boundary (invariant I2)
 * ------------------------------------------------
 * A worker serves ONE tenant at a time. `selectWorker` is handed the set of
 * currently-leased keys and answers with an idle worker or a refusal -- never
 * with "the least busy one", which is the pooling arrangement I2 names as a
 * cross-tenant leak whatever it is called. A refusal is a 503, not a share.
 *
 * Why the logic lives in `domain/`
 * -------------------------------
 * It imports nothing, so a spec can import it and test behaviour. The same
 * code inside `webrain-mcp.ts` would drag the Firebase Admin app and a
 * Secret Manager client in at module load. Supply is deliberately not this
 * module's business: the pool arrives as an argument, resolved per call by
 * `infrastructure/webrain-config.store.ts`.
 */

/**
 * One usable worker: the call uses `url`, an operator reads `label`.
 */
export interface WorkerEntry {
  label: string
  url: string
}

/**
 * A display label for a worker URL, unique per endpoint.
 *
 * Port-inclusive ON PURPOSE, and this is where a worker pool differs from the
 * proxy pool it otherwise mirrors. Proxies normally have one exit per host, so
 * a hostname names one. Workers routinely do not: several share a host on
 * different ports -- `127.0.0.1:9223` plus `:9224` is the local dev case, and
 * one machine running `--workers N` is the production one. A hostname-only
 * label would collapse those into a single lease key, so two tenants would
 * each believe they held the same worker exclusively.
 * @param {string} url The worker's base URL.
 * @param {number} index Its position, used when the URL will not parse.
 * @return {string} A label that never carries credentials.
 */
export const workerLabel = (url: string, index: number): string => {
  const fallback = `worker-${index + 1}`

  try {
    const parsed = new URL(url)
    // A parse that succeeds is NOT proof of a usable endpoint. `new URL`
    // accepts `user:pass@host` as scheme `user:` with an EMPTY hostname, so the
    // hostname has to be checked rather than assumed -- an empty label would
    // collapse two entries into one display row.
    if (!parsed.hostname) {
      return fallback
    }

    return parsed.port ?
      `${parsed.hostname}:${parsed.port}` :
      parsed.hostname
  } catch {
    // Position, never the raw string: a malformed entry is exactly where a
    // credential could otherwise reach a log or an admin table.
    return fallback
  }
}

/**
 * The key a lease is held under.
 *
 * The URL rather than the label: two entries share a label only by being the
 * same endpoint, and a lease must be exactly as unique as its endpoint. Safe
 * to hold in Redis -- a worker URL carries no credentials, unlike a proxy URL.
 * @param {WorkerEntry} entry The worker.
 * @return {string} The lease key.
 */
export const workerLeaseKey = (entry: WorkerEntry): string => entry.url

/**
 * Why a browser call could not be given a worker.
 *
 * Both are refusals rather than fallbacks. `no_workers_configured` is the
 * state until a pool is configured, so the route answering it is a normal
 * path -- and it must never be mistaken for a browserless success, which
 * would answer a JS shell as though it were content.
 */
export type WorkerRefusal = "no_workers_configured" | "all_workers_busy"

/**
 * The outcome of asking for a worker.
 */
export type WorkerSelection =
  {ok: true, worker: WorkerEntry, key: string} |
  {ok: false, reason: WorkerRefusal}

/**
 * Pick an idle worker, or refuse.
 *
 * Deterministic -- configured order, no randomness -- so a spec asserts the
 * choice directly and two calls in one process cannot disagree off the same
 * input. Atomicity of the lease itself is the caller's job: this only decides
 * whether one is available.
 * @param {WorkerEntry[]} workers The configured pool, in order.
 * @param {ReadonlySet<string>} busy Lease keys currently held by anyone.
 * @return {WorkerSelection} An idle worker, or why there is none.
 */
export const selectWorker = (
  workers: WorkerEntry[],
  busy: ReadonlySet<string>
): WorkerSelection => {
  if (workers.length === 0) {
    return {ok: false, reason: "no_workers_configured"}
  }

  const idle = workers.find((worker) => !busy.has(workerLeaseKey(worker)))
  if (!idle) {
    return {ok: false, reason: "all_workers_busy"}
  }

  return {ok: true, worker: idle, key: workerLeaseKey(idle)}
}

/**
 * How long a worker lease lives, in seconds.
 *
 * A lease is a claim on one worker for one browser call, and it has to outlive
 * the call without outliving a crash by much. It is the self-healing
 * mechanism: a process that dies mid-call cannot release, so the key must
 * expire on its own. Too long strands a worker; too short expires a lease
 * under a live call and hands that worker to a second tenant, which is the
 * leak the lease exists to prevent.
 */
export const WORKER_LEASE_TTL_SECONDS = 120

/**
 * The Redis key a worker's lease is held under.
 *
 * Keyed by URL, matching `workerLeaseKey`, so the lease and the selection rule
 * cannot disagree about which endpoint is which. No credential is involved --
 * a worker URL carries none -- so the key is safe to hold and to compare.
 * @param {WorkerEntry} entry The worker.
 * @return {string} The Redis key.
 */
export const workerLeaseRedisKey = (entry: WorkerEntry): string =>
  `webrain:workers:lease:${entry.url}`

/**
 * Whether a claim reply means this caller actually holds the lease.
 *
 * FAILS CLOSED, and that is a trap rather than a precaution. With Redis
 * unconfigured, `app/cacheConfig.ts` substitutes a no-op client whose `set`
 * answers `"OK"` and whose `eval` answers a fixed `[null, "ok"]` -- so a claim
 * written against the command's own return value reports SUCCESS when there is
 * no Redis at all, hands the same worker to every caller, and turns I2 into a
 * comment. Requiring a real holder token means the stub refuses by
 * construction.
 *
 * Do not "fix" this by normalising the stub to return a string.
 * @param {unknown} result Whatever the claim script returned.
 * @return {boolean} True only when a holder token came back.
 */
export const leaseGrantedBy = (result: unknown): boolean =>
  typeof result === "string" && result.length > 0

/**
 * How a call should obtain a worker.
 *
 * A value rather than a performed lookup so the ORDER is testable, because the
 * order is the safety property: the pool is tried first, and `use-single` is
 * reachable **only** when no pool is configured. Once a pool exists, a fully
 * busy pool must not quietly degrade to the shared single worker -- that is
 * precisely the sharing the pool was introduced to remove.
 */
export type WorkerPlan =
  {kind: "try-pool", order: WorkerEntry[]} |
  {kind: "use-single", url: string} |
  {kind: "refuse", reason: WorkerRefusal}

/**
 * Decide where a call looks for a worker.
 *
 * Three branches, and deliberately no fourth:
 *  - a configured pool -> try each worker in order until one claims;
 *  - no pool but a single worker URL -> use it, unleased. A lone worker cannot
 *    be pooled, and refusing here would break local dev without making anything
 *    safer: there is no second caller to be isolated from;
 *  - neither -> refuse. The caller must not read this as "fetch without a
 *    browser", because that answers a browser-requiring call with a JS shell.
 *
 * `singleUrl` is ignored whenever the pool is non-empty. That is not an
 * oversight; it is the point of the function.
 * @param {WorkerEntry[]} pool The configured worker pool.
 * @param {string} singleUrl The legacy single-worker URL.
 * @return {WorkerPlan} Which branch the call takes.
 */
export const planWorkerAcquisition = (
  pool: WorkerEntry[],
  singleUrl: string
): WorkerPlan => {
  if (pool.length > 0) {
    return {kind: "try-pool", order: pool}
  }

  if (singleUrl) {
    return {kind: "use-single", url: singleUrl}
  }

  return {kind: "refuse", reason: "no_workers_configured"}
}
