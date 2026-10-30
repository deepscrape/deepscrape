/* eslint-disable object-curly-spacing */
/**
 * The scheduled half of `/operations` — the run that STARTED itself.
 *
 * Why this exists
 * --------------
 * A "Scheduled" operation was a stored row and nothing else: the action wrote it
 * with a `scheduled_At` and no dispatcher ever read that field, so the promise on
 * the button was never kept. The old `enqueueCrawlOperation` trigger in
 * `app/auth.ts` looked like the missing half but its queue push was commented
 * out and it was never exported from `index.ts`, so it had never run.
 *
 * Why a timer and not a trigger
 * ----------------------------
 * A Firestore trigger fires on a WRITE, and "the time has come" is not a write.
 * Something has to look at the clock, which is exactly what a scheduled function
 * is for. The claim is transactional (see `claimDueOperations`), so an
 * overlapping tick is harmless.
 *
 * Why it dispatches through the SAME enqueue as the HTTP route
 * ----------------------------------------------------------
 * A scheduled run has to produce the identical job: same row shape, same
 * documents, same cancel and results routes, same worker provenance. Anything
 * that re-implemented queueing here would drift from the route the moment either
 * changed, and the divergence would only be visible on the path nobody watches.
 */
import { onSchedule } from "firebase-functions/v2/scheduler"
import { onDocumentDeleted } from "firebase-functions/v2/firestore"
import { functionsEnvJson } from "../config/env"
import { isChargeableAccessMode } from "../domain/billing.domain"
import { db, dbName } from "../app/config"
import { accessModeOf } from "../infrastructure/access-mode.store"
import {
  claimDueOperations,
  type DueOperation,
} from "../infrastructure/operation-schedule.store"
import {
  enqueueJobCore,
  unitsForOperation,
} from "../handlers/webrain-jobs"

/** Why a claimed row was not dispatched, when the reason is not a queue error. */
const PLAN_REQUIRED =
  "A paid plan is required to run a scheduled job. Reschedule it once the " +
  "account has one."
const NO_TARGETS =
  "This scheduled job has nothing to run: it names neither a tool nor a URL."

/**
 * Marks a claimed row as failed, with the reason the user can act on.
 *
 * `Failed` rather than back to `Scheduled`: a plan that lapsed or a row with no
 * targets will fail identically on the next tick, and re-scheduling it would
 * retry a permanent condition every five minutes for ever.
 * @param {string} uid The owner.
 * @param {string} id The operation.
 * @param {string} message Why it could not run.
 * @return {Promise<void>} Resolves once the row is written.
 */
const markFailed = async (
  uid: string,
  id: string,
  message: string
): Promise<void> => {
  await db
    .collection("users")
    .doc(uid)
    .collection("operations")
    .doc(id)
    .set({ status: "Failed", error: message }, { merge: true })
}

/**
 * Runs one claimed row.
 *
 * The entitlement is re-read HERE rather than inherited from whatever it was when
 * the row was written: a plan that lapsed between scheduling and running must
 * not spend the platform's worker time, which is the same rule the HTTP route
 * enforces with its `paid` guard.
 * @param {DueOperation} operation The claimed row.
 * @return {Promise<void>} Resolves once the row is dispatched or failed.
 */
const dispatchOperation = async (operation: DueOperation): Promise<void> => {
  const { uid, id, data } = operation
  const accessMode = await accessModeOf(uid)

  if (!isChargeableAccessMode(accessMode)) {
    await markFailed(uid, id, PLAN_REQUIRED)
    return
  }

  const units = unitsForOperation(data)
  if (!units.length) {
    await markFailed(uid, id, NO_TARGETS)
    return
  }

  // The row already owns its id, and `enqueueJobCore` reuses it so the user's
  // list entry is the one that starts moving instead of gaining a sibling.
  const tool = typeof data["tool"] === "string" ? data["tool"] : undefined
  const extra =
    tool ?
      { tool, args: (data["args"] as Record<string, unknown>) ?? {} } :
      {}

  const outcome = await enqueueJobCore(
    uid,
    units,
    id,
    data,
    accessMode,
    extra
  )

  if (outcome.status === 200) {
    console.log(`operations: dispatched ${id} (${outcome.total} target(s))`)
    return
  }

  await markFailed(uid, id, outcome.message)
}

/**
 * Dispatches every operation whose scheduled time has come.
 *
 * Per-row failures are contained: one row that cannot be dispatched is marked
 * and the loop continues, because a single bad row must not stop the rest of the
 * batch.
 */
export const runDueOperations = onSchedule(
  {
    // Every five minutes, matching the monitor drain: both are "what is due
    // now?" sweeps, and one interval for the two is one thing to reason about.
    schedule: "*/5 * * * *",
    timeZone: "UTC",
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "256MiB",
    // Without this binding the queue has no QSTASH_* and every dispatch would
    // be recorded as "queue is not configured" -- a scheduler that looks broken
    // while the fault is a missing secret.
    secrets: [functionsEnvJson],
  },
  /**
   * callback
   * @return {Promise<void>} Resolves once the batch has been attempted.
   */
  async () => {
    let claimed: DueOperation[] = []

    try {
      claimed = await claimDueOperations(Date.now())
    } catch (error) {
      // A failed claim query is logged and returned: there is nothing to
      // dispatch, and throwing would only retry the same failing query.
      console.error("operations: claim failed:", error)
      return
    }

    if (!claimed.length) {
      return
    }

    console.log(`operations: dispatching ${claimed.length} scheduled run(s)`)

    for (const operation of claimed) {
      try {
        await dispatchOperation(operation)
      } catch (error) {
        console.error(`operations: ${operation.id} failed to dispatch:`, error)
        await markFailed(
          operation.uid,
          operation.id,
          "The job could not be queued. Reschedule it to try again."
        )
      }
    }
  }
)

/**
 * Takes the job document with the operation it belongs to.
 *
 * The list's delete removes `operations/{id}` (and soft-deletes the metrics row
 * for the audit trail) and nothing else, so the `crawljobs` document — which
 * holds every target's payload — outlived its operation for ever. It is not
 * reachable from the client (no rule grants it), so the fix cannot be a client
 * delete: this runs server-side, on the one event that means "the user removed
 * this run".
 *
 * `task_id` is what names the job, because the two documents are not always the
 * same id: a SCHEDULED run keeps its own operations document and the job gets a
 * fresh id. A row with no `task_id` never had a job, so there is nothing to take.
 */
export const purgeDeletedOperationJob = onDocumentDeleted(
  {
    document: "users/{userId}/operations/{operationId}",
    database: dbName,
  },
  /**
   * callback
   * @param {*} event The delete event.
   * @return {Promise<void>} Resolves once the job document is gone.
   */
  async (event) => {
    const uid = event.params.userId
    const taskId = event.data?.data()?.["task_id"]

    if (typeof taskId !== "string" || !taskId) {
      return
    }

    try {
      await db
        .collection("users")
        .doc(uid)
        .collection("crawljobs")
        .doc(taskId)
        .delete()
    } catch (error) {
      // Loud, not thrown: a retry of this event deletes the same document, and
      // an operation that is already gone must not resurrect anything.
      console.error(`operations: could not purge job ${taskId}:`, error)
    }
  }
)
