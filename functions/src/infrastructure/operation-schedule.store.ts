/* eslint-disable object-curly-spacing */
/**
 * The claim query for SCHEDULED operations.
 *
 * Why `status == "Scheduled"` alone, and the due-time filtered in memory
 * ---------------------------------------------------------------------
 * A composite index (`status asc, scheduled_At asc`) would let Firestore do the
 * filtering, and it is the "right" query. It is not what this ships: the index
 * has to be DEPLOYED before the query works, and a missing one is not a slow
 * page — it is a hard 400 on every run, which reads as "scheduling is broken"
 * with no clue why. An equality filter on one field uses the automatic
 * single-field index, so this query cannot be broken by a deploy order.
 *
 * The cost is bounded and stated: `limit` caps how many scheduled rows one tick
 * reads, and a row whose time has not come is simply skipped. With more
 * scheduled rows than the cap, the ones beyond it wait for a later tick —
 * acceptable for a five-minute dispatch, and the reason the cap is generous.
 *
 * shortcut: a batch of scheduled rows larger than the cap delays the tail of
 * them rather than dropping any, upgrade to the composite index when the number
 * of pending scheduled rows approaches it.
 */
import { db } from "../app/config"

/** One operation the scheduler has claimed, and the row it came from. */
export interface DueOperation {
  uid: string
  id: string
  data: Record<string, unknown>
}

/** How many scheduled rows one tick reads at most. */
export const OPERATION_DISPATCH_BATCH = 200

/**
 * Claims every operation whose time has come.
 *
 * A claim is a transaction that re-reads the row and flips `Scheduled` to
 * `In Progress` BEFORE anything is queued, so two overlapping ticks cannot both
 * dispatch one row. The flip is also what makes an in-flight dispatch visible:
 * a row reading `In Progress` is one the scheduler has taken.
 *
 * A `scheduled_At` that is missing or unparseable is SKIPPED rather than run: a
 * row with no time is a bug in whatever wrote it, and running it every five
 * minutes would turn one bad row into a recurring job.
 * @param {number} now The current epoch millis.
 * @param {number} limit The most rows to read.
 * @return {Promise<DueOperation[]>} The rows this run may dispatch.
 */
export const claimDueOperations = async (
  now: number,
  limit: number = OPERATION_DISPATCH_BATCH
): Promise<DueOperation[]> => {
  const snapshot = await db
    .collectionGroup("operations")
    .where("status", "==", "Scheduled")
    .limit(limit)
    .get()

  const claimed: DueOperation[] = []

  for (const row of snapshot.docs) {
    const due = row.get("scheduled_At")
    if (typeof due !== "number" || due > now) {
      continue
    }

    // `users/{uid}/operations/{id}` — the parent of the parent is the user.
    const uid = row.ref.parent.parent?.id
    if (!uid) {
      continue
    }

    const won = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(row.ref)
      if (!fresh.exists || fresh.get("status") !== "Scheduled") {
        return false
      }
      tx.update(row.ref, {
        status: "In Progress",
        updated_At: Date.now(),
      })
      return true
    })

    if (won) {
      claimed.push({ uid, id: row.id, data: row.data() })
    }
  }

  return claimed
}
