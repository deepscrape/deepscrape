/* eslint-disable object-curly-spacing */
/**
 * Turning the pool into a URL for one call.
 *
 * `webrain-worker-lease.ts` holds the lease primitives, keyed by worker. This
 * is the layer that decides which worker a call may have, takes it, and
 * guarantees it is handed back. The order it follows is
 * `planWorkerAcquisition`'s, and the reasoning for each branch is documented
 * there rather than repeated here.
 *
 * The lease covers the REQUEST, and nothing else
 * ----------------------------------------------
 * A call holds its worker from just before the request goes out until the
 * response body has been read -- not through the JSON parsing, signal
 * extraction and result building that follow. Those are pure CPU over a body
 * already in hand, so holding a lease through them would strand capacity for no
 * safety benefit.
 *
 * It is held across the network, and that is unavoidable: the worker is the
 * thing being used, so the window in which one tenant may use it is exactly the
 * window in which it is used.
 *
 * What this does NOT do
 * ---------------------
 * It never falls back to a browserless fetch. A caller that needs a browser and
 * cannot get one has to say so; answering from the browserless scrape path
 * would return a JS shell as though it were content -- a wrong answer, not a
 * slow one. That decision belongs to the caller, which knows what it needed.
 */
import {randomUUID} from "node:crypto"
import {
  planWorkerAcquisition,
  type WorkerRefusal,
} from "../domain/webrain-workers.domain"
import {claimWorkerLease, releaseWorkerLease} from "./webrain-worker-lease"
import {webrainWorkerPool} from "./webrain-config.store"

/**
 * The worker a call may use, and the way to give it back.
 */
export interface WorkerTarget {
  url: string
  /** True when an exclusive lease was taken and `release` must be awaited. */
  leased: boolean
  release: () => Promise<void>
}

/**
 * The outcome of asking for a worker.
 */
export type WorkerTargetResult =
  {ok: true, target: WorkerTarget} |
  {ok: false, reason: WorkerRefusal}

/** The release for a worker that was never leased. */
const noRelease = async (): Promise<void> => undefined

/**
 * Take a worker for one call.
 *
 * Never rejects: every failure is a refusal a caller can turn into a 503.
 * @param {string} singleUrl The single-worker URL from `WEBRAIN_MCP_URL`.
 * @return {Promise<WorkerTargetResult>} A target, or why there is none.
 */
export const acquireWorkerTarget = async (
  singleUrl: string
): Promise<WorkerTargetResult> => {
  const plan = planWorkerAcquisition(await webrainWorkerPool(), singleUrl)

  if (plan.kind === "use-single") {
    // Unleased, and correctly so for a lone worker: there is no second caller
    // to exclude from it.
    return {
      ok: true,
      target: {url: plan.url, leased: false, release: noRelease},
    }
  }

  if (plan.kind === "refuse") {
    return {ok: false, reason: plan.reason}
  }

  // One holder token for the whole walk, so the claim and the release cannot
  // disagree about which claim was ours.
  const holder = randomUUID()
  for (const worker of plan.order) {
    if (await claimWorkerLease(worker, holder)) {
      return {
        ok: true,
        target: {
          url: worker.url,
          leased: true,
          release: async () => {
            await releaseWorkerLease(worker, holder)
          },
        },
      }
    }
  }

  // Every worker refused. Refuse as well -- see the module comment for why this
  // is not a browserless retry.
  return {ok: false, reason: "all_workers_busy"}
}
