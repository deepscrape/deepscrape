/* eslint-disable object-curly-spacing */
/**
 * Where monitors and their checks live, and the only places that touch them.
 *
 * Why a store module
 * -----------------
 * Every monitor route and the scheduler's drain need the same two guarantees,
 * and neither is the other's child: (1) a monitor is only ever read or written
 * by its owner, and (2) a check write is one document plus one counter update,
 * not two independent statements that can disagree. Both live here so that no
 * handler can be the one that forgets.
 *
 * The scoping rule, in one sentence
 * --------------------------------
 * A monitor is addressed by an id the CALLER supplies, so the id proves
 * nothing: every read here fetches the document and then requires
 * `isOwnedBy(data, uid)` before returning anything, and every mutation does the
 * same read before it writes. A foreign id answers exactly like a missing one —
 * `undefined` / `not-found` — so the surface cannot be used to test whether
 * another account's monitor exists.
 *
 * Cost shape
 * ----------
 * Per-user listings are bounded by `MONITOR_MAX_PER_USER` and sorted in memory
 * rather than with `orderBy`, because an equality filter plus an `orderBy` on a
 * different field is a COMPOSITE index — a deploy step for a list of at most 20
 * documents. The only composite-free queries here are single-field: the drain's
 * range on `nextCheckAt`, the checks' `orderBy("at")`, and the `uid` equality.
 */
import { db } from "../app/config"
import {
  MONITOR_CHECK_RETENTION,
  MONITOR_MAX_PER_USER,
  MONITOR_PRUNE_BATCH,
  clampIntervalMinutes,
  isOwnedBy,
  nextCheckAtFor,
  nextConsecutiveErrors,
  type MonitorCheckFields,
  type MonitorCheckRecord,
  type MonitorFields,
  type MonitorRecord,
} from "../domain/monitors.domain"

/** The top-level collection, per the design: `monitors/{id}`. */
export const MONITOR_COLLECTION = "monitors"

/** The per-monitor history: `monitors/{id}/checks/{checkId}`. */
export const MONITOR_CHECKS_COLLECTION = "checks"

/** One monitor by id, with no ownership check attached.
 * @param {string} id The monitor id.
 * @return {*} A document reference.
 */
const monitorRef = (id: string) =>
  db.collection(MONITOR_COLLECTION).doc(id)

/** One monitor's check history.
 * @param {string} id The monitor id.
 * @return {*} A collection reference.
 */
const checksRef = (id: string) =>
  monitorRef(id).collection(MONITOR_CHECKS_COLLECTION)

/**
 * The stored monitor, or undefined when it is missing or not the caller's.
 *
 * Both cases return undefined deliberately: telling them apart would let a
 * caller probe for the existence of another account's monitors, and neither
 * answer changes what the caller may do next.
 * @param {string} uid The calling account.
 * @param {string} id The monitor id the caller supplied.
 * @return {Promise<MonitorRecord | undefined>} The monitor, or undefined.
 */
export const readMonitor = async (
  uid: string,
  id: string
): Promise<MonitorRecord | undefined> => {
  if (!id) {
    return undefined
  }

  const snapshot = await monitorRef(id).get()
  if (!snapshot.exists) {
    return undefined
  }

  const data = snapshot.data() as MonitorFields | undefined
  if (!isOwnedBy(data, uid)) {
    return undefined
  }

  return { id: snapshot.id, ...(data as MonitorFields) }
}

/**
 * Every monitor this account owns, newest first.
 *
 * The `limit` is the per-user cap, which is also what the create route
 * enforces — so this read is bounded by the same constant that bounds the
 * account, and the in-memory sort avoids the composite index the `orderBy`
 * would need.
 * @param {string} uid The calling account.
 * @return {Promise<MonitorRecord[]>} The account's monitors.
 */
export const listMonitors = async (
  uid: string
): Promise<MonitorRecord[]> => {
  const snapshot = await db
    .collection(MONITOR_COLLECTION)
    .where("uid", "==", uid)
    .limit(MONITOR_MAX_PER_USER)
    .get()

  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() as MonitorFields) }))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * How many monitors this account already has.
 *
 * A count aggregation rather than a `get()`: the create route only needs the
 * number, and the aggregation is billed per 1,000 index entries instead of per
 * document.
 * @param {string} uid The calling account.
 * @return {Promise<number>} The number of monitors.
 */
export const countMonitors = async (uid: string): Promise<number> => {
  const snapshot = await db
    .collection(MONITOR_COLLECTION)
    .where("uid", "==", uid)
    .count()
    .get()

  return snapshot.data().count
}

/**
 * Writes one new monitor and returns it with its generated id.
 * @param {string} uid The owning account.
 * @param {MonitorFields} fields The validated document fields.
 * @return {Promise<MonitorRecord>} The stored monitor.
 */
export const createMonitor = async (
  uid: string,
  fields: MonitorFields
): Promise<MonitorRecord> => {
  const ref = db.collection(MONITOR_COLLECTION).doc()
  // The id is minted here rather than trusted from the body: a caller-supplied
  // id would be a way to overwrite another account's document.
  await ref.set(fields)
  return { id: ref.id, ...fields }
}

/**
 * Merges a validated patch into a monitor the caller owns.
 * @param {string} uid The calling account.
 * @param {string} id The monitor id.
 * @param {Record<string, unknown>} patch The fields to merge.
 * @return {Promise<MonitorRecord | undefined>} The updated monitor, if owned.
 */
export const updateMonitor = async (
  uid: string,
  id: string,
  patch: Record<string, unknown>
): Promise<MonitorRecord | undefined> => {
  const current = await readMonitor(uid, id)
  if (!current) {
    return undefined
  }

  await monitorRef(id).set(patch, { merge: true })
  return { ...current, ...(patch as Partial<MonitorFields>) }
}

/**
 * Deletes a monitor and its check history.
 *
 * `recursiveDelete` rather than a doc delete: the checks are a subcollection
 * and therefore NOT removed with their parent, so deleting only the parent
 * would leave up to `MONITOR_CHECK_RETENTION` orphaned documents per monitor
 * that nothing would ever read or clean up.
 * @param {string} uid The calling account.
 * @param {string} id The monitor id.
 * @return {Promise<boolean>} True when a monitor was found and deleted.
 */
export const deleteMonitor = async (
  uid: string,
  id: string
): Promise<boolean> => {
  const current = await readMonitor(uid, id)
  if (!current) {
    return false
  }

  await db.recursiveDelete(monitorRef(id))
  return true
}

/**
 * The newest checks for one monitor the caller owns.
 * @param {string} uid The calling account.
 * @param {string} id The monitor id.
 * @param {number} limit The already-clamped number of rows to read.
 * @return {Promise<MonitorCheckRecord[] | undefined>} Rows, or undefined when
 *   the monitor is not the caller's.
 */
export const listChecks = async (
  uid: string,
  id: string,
  limit: number
): Promise<MonitorCheckRecord[] | undefined> => {
  const current = await readMonitor(uid, id)
  if (!current) {
    return undefined
  }

  const snapshot = await checksRef(id)
    .orderBy("at", "desc")
    .limit(limit)
    .get()

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as MonitorCheckFields),
  }))
}

/**
 * Trims a monitor's history back to the retention bound.
 *
 * Amortised, not per-write: the count is only consulted once the collection is
 * `MONITOR_PRUNE_BATCH` rows over the bound, and one prune then removes exactly
 * that many of the OLDEST rows. Over a long run that is roughly one `count()`
 * and one delete per check, instead of a count plus a delete on every check.
 *
 * Failures are swallowed: an over-long history is a cost problem, and failing
 * the check that just succeeded (and which the caller may already have been
 * told about) to report it would be the wrong trade.
 * @param {string} id The monitor id.
 * @return {Promise<void>} Resolves once the attempt finishes.
 */
const pruneChecks = async (id: string): Promise<void> => {
  try {
    const collection = checksRef(id)
    const total = (await collection.count().get()).data().count
    const excess = total - MONITOR_CHECK_RETENTION

    if (excess < MONITOR_PRUNE_BATCH) {
      return
    }

    const oldest = await collection
      .orderBy("at", "asc")
      .limit(Math.min(excess, MONITOR_PRUNE_BATCH))
      .get()

    const batch = db.batch()
    oldest.docs.forEach((doc) => batch.delete(doc.ref))
    await batch.commit()
  } catch (error) {
    console.warn(`monitor ${id}: check prune failed:`, error)
  }
}

/**
 * Records one check: the row, the monitor's new state, then the prune.
 *
 * The order matters. The row is written first because it is the evidence, and
 * the monitor's summary is derived from it; a crash between the two leaves an
 * unread row rather than a monitor claiming a check that never happened.
 * @param {MonitorFields} monitor The monitor that was checked.
 * @param {MonitorCheckFields} row The check row to write.
 * @param {Record<string, string>} validators Any validator headers the worker
 *   reported. Empty today — see `validatorsFromScrape`.
 * @return {Promise<void>} Resolves once both writes have been attempted.
 */
export const recordCheck = async (
  monitor: MonitorFields & { id: string },
  row: MonitorCheckFields,
  validators: Record<string, string> = {}
): Promise<void> => {
  const checks = checksRef(monitor.id)
  await checks.doc().set(row)

  const summary: Record<string, unknown> = {
    lastStatus: row.status,
    consecutiveErrors: nextConsecutiveErrors(
      monitor.consecutiveErrors ?? 0,
      row.status
    ),
    updatedAt: row.at,
    ...validators,
  }

  // Never an undefined field value: Firestore rejects the whole write for one,
  // so a hash is only carried when the check actually produced one.
  if (row.hash) {
    summary["lastHash"] = row.hash
  }

  try {
    await monitorRef(monitor.id).set(summary, { merge: true })
  } catch (error) {
    // The monitor was deleted between the claim and this write. The row above
    // is already gone with it (recursiveDelete), so there is nothing to undo.
    console.warn(`monitor ${monitor.id}: summary write failed:`, error)
  }

  await pruneChecks(monitor.id)
}

/**
 * Claims the monitors whose turn it is, and advances them.
 *
 * Claim-then-check, not check-then-claim: the due-time moves BEFORE the worker
 * is called, so two schedulers that overlap (or a run that outlives its
 * five-minute slot) cannot both check the same page. The price of that
 * ordering is that a crash mid-check burns one interval rather than repeating
 * it — the right trade for a monitor, where a missed check is an inconvenience
 * and a duplicated one is a wasted worker request.
 *
 * The query is a single-field range, which needs no composite index. Disabled
 * monitors are excluded by their parked `nextCheckAt` rather than by a second
 * filter, for the same reason.
 * @param {number} now Epoch milliseconds.
 * @param {number} limit The most monitors to claim in one run.
 * @return {*} The claimed monitors.
 */
export const claimDueMonitors = async (
  now: number,
  limit: number
): Promise<Array<MonitorFields & { id: string }>> => {
  const snapshot = await db
    .collection(MONITOR_COLLECTION)
    .where("nextCheckAt", "<=", now)
    .orderBy("nextCheckAt")
    .limit(limit)
    .get()

  const claimed: Array<MonitorFields & { id: string }> = []

  for (const doc of snapshot.docs) {
    const data = doc.data() as MonitorFields

    // A monitor switched off after the query but before the claim: skip it
    // rather than check a page the owner has already stopped watching.
    if (data.enabled !== true) {
      continue
    }

    const intervalMinutes = clampIntervalMinutes(data.intervalMinutes)
    const nextCheckAt = nextCheckAtFor(true, intervalMinutes, now)

    try {
      await doc.ref.set(
        { nextCheckAt, lastCheckedAt: now, updatedAt: now },
        { merge: true }
      )
    } catch (error) {
      // Another run claimed it first, or it was deleted. Either way this run
      // must not check it.
      console.warn(`monitor ${doc.id}: claim lost:`, error)
      continue
    }

    claimed.push({ id: doc.id, ...data, lastCheckedAt: now, nextCheckAt })
  }

  return claimed
}
