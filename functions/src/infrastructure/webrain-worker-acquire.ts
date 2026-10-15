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
  type OwnMachine,
  type WorkerRefusal,
} from "../domain/webrain-workers.domain"
import {claimWorkerLease, releaseWorkerLease} from "./webrain-worker-lease"
import {webrainWorkerPool} from "./webrain-config.store"

/**
 * How a target is reached, and therefore which credential authenticates it.
 *
 * Two routes, and they are not interchangeable. `engine` is webrain's own `/mcp`
 * endpoint on a platform worker, authenticated with the WORKER token this
 * platform holds. `machine` is a machine the caller leased, reached through
 * arachnefly's `/api/machine/mcp/:id`, which checks ownership against the
 * CALLER'S ID token and injects the machine's own token upstream. So the
 * credential travels in opposite directions, and a target that did not say which
 * route it was would have to guess: guessing wrong means sending the platform's
 * worker token to a caller-owned machine, or the caller's token to ours.
 */
export type WorkerTargetTransport =
  {kind: "engine"} |
  {kind: "machine", machine: OwnMachine}

/**
 * The worker a call may use, and the way to give it back.
 */
export interface WorkerTarget {
  /**
   * The engine's base URL. EMPTY for a machine, which is addressed by id rather
   * than reached directly -- see `transport`.
   */
  url: string
  /**
   * True when no other tenant may be inside this browser while the call runs.
   *
   * Two ways to qualify, which is why this is not called `leased`. A pool lease
   * is taken for the call and given back; a machine the caller leased for their
   * SESSION holds no pool lease at all. What both share, and all any consumer of
   * this field needs, is that the caller has the browser to themselves -- which
   * is what `needsExclusiveWorker` is actually asking.
   */
  exclusive: boolean
  /**
   * Give the worker back. A NO-OP for a machine, and that is load-bearing rather
   * than tidy: releasing is how a pool lease returns capacity, but a machine is
   * not pool capacity -- so "releasing" one would tear down the session the
   * caller is watching.
   */
  release: () => Promise<void>
  /** Which route reaches it, and which credential that route needs. */
  transport: WorkerTargetTransport
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
 * @param {OwnMachine} [ownMachine] A machine the caller leased for their own
 *   session, when the tool may run on one and they have one. It wins over the
 *   pool: their own browser is both the correct browser for the task -- it holds
 *   their cookies, their logins and the page they are watching -- and the one
 *   they are already being billed for by the minute.
 * @return {Promise<WorkerTargetResult>} A target, or why there is none.
 */
export const acquireWorkerTarget = async (
  singleUrl: string,
  ownMachine?: OwnMachine
): Promise<WorkerTargetResult> => {
  const plan = planWorkerAcquisition(
    await webrainWorkerPool(),
    singleUrl,
    ownMachine
  )

  if (plan.kind === "use-own-machine") {
    // No claim is taken and none is given back. The machine is already the
    // caller's -- that is what makes it exclusive -- so a Redis claim could only
    // add a way for this to fail, and a real release would end their session.
    return {
      ok: true,
      target: {
        url: "",
        exclusive: true,
        release: noRelease,
        transport: {kind: "machine", machine: plan.machine},
      },
    }
  }

  if (plan.kind === "use-single") {
    // Unleased, and correctly so for a lone worker: there is no second caller
    // to exclude from it.
    return {
      ok: true,
      target: {
        url: plan.url,
        exclusive: false,
        release: noRelease,
        transport: {kind: "engine"},
      },
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
          exclusive: true,
          release: async () => {
            await releaseWorkerLease(worker, holder)
          },
          transport: {kind: "engine"},
        },
      }
    }
  }

  // Every worker refused. Refuse as well -- see the module comment for why this
  // is not a browserless retry.
  return {ok: false, reason: "all_workers_busy"}
}
