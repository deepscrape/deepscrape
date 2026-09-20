/* eslint-disable max-len */
/* eslint-disable require-jsdoc */
/**
 * CLI for auditing the admin-panel analytics against the collections they are
 * supposed to come from.
 *
 * Answers one question: is a wrong/empty panel the result of a broken query, or
 * of data that was never written? It prints, per UTC day, the raw counts
 * (`guests` by `createdAt`, `analytics_events` by `date`) next to the counters
 * `metrics_daily` claims for that same day, then dumps the summary/range docs the
 * panel maps onto its cards.
 *
 * Usage:
 *   npx tsx functions/scripts/analytics-audit-cli.ts        # last 14 days
 *   npx tsx functions/scripts/analytics-audit-cli.ts 30     # last 30 days
 *
 * Credentials: Application Default Credentials (gcloud auth application-default
 * login, or GOOGLE_APPLICATION_CREDENTIALS). No secrets are read or printed.
 *
 * ponytail: read-only, no repo imports — the app's env layer pulls Secret Manager
 * and would fail outside the runtime. `firestore.ts`/`analytics-realtime.ts` own
 * the write side; this only observes it.
 */

import {applicationDefault, getApps, initializeApp} from "firebase-admin/app"
import {getFirestore, Timestamp} from "firebase-admin/firestore"
import type {Firestore, Query} from "firebase-admin/firestore"

const PROJECT_ID_DEFAULT = "libnet-d76db"
const DATABASE_ID_DEFAULT = "easyscrape"

/**
 * Locally, dotenvx leaves `encrypted:…` ciphertext in the environment. Trusting one
 * as a project id produces `PERMISSION_DENIED` against a project that does not
 * exist, which reads like a credentials failure. Same guard the Redis layer applies.
 *
 * @param {string|undefined} value Candidate env value.
 * @param {RegExp} shape Allowed shape once decrypted.
 * @return {string|null} The value when usable, otherwise null.
 */
const usableId = (value: string | undefined, shape: RegExp): string | null => {
  const trimmed = (value || "").trim()
  if (!trimmed || /^encrypted:/i.test(trimmed) || !shape.test(trimmed)) {
    return null
  }
  return trimmed
}

const PROJECT_ID =
  usableId(process.env["GCLOUD_PROJECT"], /^[a-z][a-z0-9-]{4,29}$/) ||
  usableId(process.env["GCP_PROJECT_ID"], /^[a-z][a-z0-9-]{4,29}$/) ||
  PROJECT_ID_DEFAULT
// The panel's data lives in the named database. Defaulting to `(default)` here is
// what produced the past FAILED_PRECONDITION incident.
const DATABASE_ID = usableId(process.env["FIRESTORE_DB_ID"], /^[a-z][a-z0-9-]{2,29}$/) || DATABASE_ID_DEFAULT

// A UTC day key, e.g. `2026-09-14`.
const dayKey = (date: Date): string => date.toISOString().slice(0, 10)

// Midnight UTC for the day that is `offsetDays` before today.
const utcDay = (offsetDays: number): Date => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offsetDays))
}

/**
 * Count documents matching a query, using the aggregation API rather than
 * reading them — the collections here are far too large to page through.
 *
 * @param {Firestore} db Named Firestore database.
 * @param {string} collection Collection to count.
 * @param {function(Query): Query} [refine] Optional query refinement.
 * @return {Promise<number|null>} The count, or null when the query itself failed.
 */
async function countOf(
  db: Firestore,
  collection: string,
  refine?: (query: Query) => Query,
): Promise<number | null> {
  try {
    let query: Query = db.collection(collection)
    if (refine) query = refine(query)
    const snapshot = await query.count().get()
    return Number(snapshot.data().count)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`  ! ${collection} count failed: ${message.slice(0, 160)}`)
    return null
  }
}

const cell = (value: number | null | undefined, width = 8): string =>
  (value === null || value === undefined ? "-" : String(value)).padEnd(width)

// Dimension keys, counting both the nested map and the flat dotted form the triggers write.
const keyCount = (doc: Record<string, unknown>, prefix: string): number => {
  const nested = doc[prefix]
  const nestedKeys = nested && typeof nested === "object" && !Array.isArray(nested) ?
    Object.keys(nested as Record<string, unknown>).length : 0
  return nestedKeys + Object.keys(doc).filter((key) => key.startsWith(`${prefix}.`)).length
}

/**
 * Sum a counter group that may be written either as a nested map (`clientEvents: {x: 1}`)
 * or as literal dotted field names (`"clientEvents.x": 1`). `set({merge:true})` produces
 * the literal form for dotted keys, so a reader that assumes only one shape reports 0 and
 * makes a working pipeline look dead.
 *
 * @param {Record<string, unknown>} data Document data.
 * @param {string} group Field group name, e.g. `clientEvents`.
 * @return {number} Total across both shapes.
 */
const sumGroup = (data: Record<string, unknown>, group: string): number => {
  const nested = Object.values((data[group] as Record<string, number> | undefined) ?? {})
    .reduce((sum, n) => sum + Number(n || 0), 0)
  const dotted = Object.entries(data)
    .filter(([key]) => key.startsWith(`${group}.`))
    .reduce((sum, [, value]) => sum + Number(value || 0), 0)
  return nested + dotted
}

/**
 * Print, per day, the raw source counts beside what `metrics_daily` recorded.
 *
 * @param {Firestore} db Named Firestore database.
 * @param {number} days How many days back to report.
 * @return {Promise<void>} Resolves once the table has been printed.
 */
async function reportDailyFunnel(db: Firestore, days: number): Promise<void> {
  console.log("\n=== Per-day source counts vs metrics_daily ===")
  console.log(
    `${"day".padEnd(12)}${"guests".padEnd(9)}${"md.newGuests".padEnd(14)}` +
    `${"events".padEnd(9)}${"md.clientEv".padEnd(12)}${"md.newUsers".padEnd(12)}funnel.guest_created`,
  )

  for (let offset = days - 1; offset >= 0; offset--) {
    const start = utcDay(offset)
    const end = utcDay(offset - 1)
    const key = dayKey(start)

    const guests = await countOf(db, "guests", (q) =>
      q.where("createdAt", ">=", Timestamp.fromDate(start)).where("createdAt", "<", Timestamp.fromDate(end)))
    const events = await countOf(db, "analytics_events", (q) => q.where("date", "==", key))

    const daily = await db.doc(`metrics_daily/${key}`).get()
    const data = (daily.exists ? daily.data() : undefined) ?? {}
    const clientEventTotal = sumGroup(data, "clientEvents")
    const funnelFromGroup = sumGroup(data, "funnel")

    console.log(
      `${key.padEnd(12)}${cell(guests, 9)}${cell(data["newGuests"] as number, 14)}` +
      `${cell(events, 9)}${cell(clientEventTotal, 12)}${cell(data["newUsers"] as number, 12)}${cell(funnelFromGroup)}`,
    )
  }
}

/**
 * Dump the documents the panel maps onto its cards.
 *
 * @param {Firestore} db Named Firestore database.
 * @return {Promise<void>} Resolves once the documents have been printed.
 */
async function reportPanelDocs(db: Firestore): Promise<void> {
  console.log("\n=== metrics_summary/dashboard (the live card row) ===")
  const summary = await db.doc("metrics_summary/dashboard").get()
  if (!summary.exists) {
    console.log("  MISSING — the panel's active-now row has no source document.")
  } else {
    const data = summary.data() ?? {}
    for (const [key, value] of Object.entries(data)) {
      const rendered = typeof value === "object" && value !== null && "toDate" in (value as object) ?
        (value as Timestamp).toDate().toISOString() : JSON.stringify(value)
      console.log(`  ${key.padEnd(26)} ${rendered}`)
    }
  }

  console.log("\n=== metrics_range/* (per-range docs the cards read) ===")
  const ranges = await db.collection("metrics_range").get()
  if (ranges.empty) {
    console.log("  EMPTY — every range card falls back to dashboard counters.")
  }
  for (const doc of ranges.docs) {
    const data = doc.data()
    const funnel = (data["funnel"] as Record<string, number> | undefined) ?? {}
    console.log(
      `  ${doc.id.padEnd(8)} guests=${data["newGuests"] ?? "-"} users=${data["newUsers"] ?? "-"} ` +
      `logins=${data["totalLogins"] ?? "-"} bots=${data["bots"] ?? "-"} ` +
      `funnel=${JSON.stringify(funnel)} byIPkeys=${keyCount(data, "byIP")} ` +
      `byRegionKeys=${keyCount(data, "byRegion")} computedAt=${data["computedAt"] ? "set" : "MISSING"}`,
    )
  }
}

/**
 * Print field names (never values) for one document per collection, so a schema
 * change shows up as a missing key instead of a silently empty panel.
 *
 * @param {Firestore} db Named Firestore database.
 * @return {Promise<void>} Resolves once the probes have been printed.
 */
async function reportSchemaProbe(db: Firestore): Promise<void> {
  console.log("\n=== Schema probe (field names only) ===")
  for (const collection of ["guests", "users", "analytics_events"]) {
    const sample = await db.collection(collection).limit(1).get()
    if (sample.empty) {
      console.log(`  ${collection.padEnd(18)} EMPTY`)
      continue
    }
    console.log(`  ${collection.padEnd(18)} ${Object.keys(sample.docs[0].data()).sort().join(", ")}`)
  }

  // `set({merge:true})` with dotted keys is the difference between a nested map and a
  // literal field named "clientEvents.page_view". The panel reads a nested map, so a
  // literal dotted field would leave the card empty while the data looks present.
  const latest = await db.collection("metrics_daily").orderBy("date", "desc").limit(1).get()
  if (!latest.empty) {
    const keys = Object.keys(latest.docs[0].data())
    const dotted = keys.filter((key) => key.includes("."))
    console.log(`  metrics_daily/${latest.docs[0].id} -> ${keys.length} fields, ${dotted.length} containing "."`)
    const groups = [...new Set(dotted.map((key) => key.split(".")[0]))]
    console.log(`    dotted groups present: ${groups.slice(0, 8).join(", ") || "(none)"}`)
    console.log(`    clientEvents counters: ${sumGroup(latest.docs[0].data(), "clientEvents")} (both shapes summed)`)
    console.log(`    funnel counters: ${sumGroup(latest.docs[0].data(), "funnel")} (both shapes summed)`)
  }
}

/**
 * Run the audit and set a non-zero exit code when a read failed outright.
 *
 * @return {Promise<void>} Resolves after the process exit code has been set.
 */
async function main(): Promise<void> {
  const daysArg = Number(process.argv[2])
  const days = Number.isFinite(daysArg) && daysArg > 0 ? Math.floor(daysArg) : 14

  const app = getApps().length ? getApps()[0] : initializeApp({credential: applicationDefault(), projectId: PROJECT_ID})
  const db = getFirestore(app, DATABASE_ID)

  console.log(`project=${PROJECT_ID} database=${DATABASE_ID} window=${days}d (UTC)`)

  const totals = {
    guests: await countOf(db, "guests"),
    users: await countOf(db, "users"),
    events: await countOf(db, "analytics_events"),
  }
  console.log(`totals: guests=${totals.guests} users=${totals.users} analytics_events=${totals.events}`)

  await reportDailyFunnel(db, days)
  await reportPanelDocs(db)
  // Item: `users` docs carry no createdAt, so "new users by day" cannot be answered from
  // that collection — but it does not need to be. The realtime trigger already increments
  // the per-day `funnel.user_registered` counter, which the range merge now reads
  // dual-shape, so the panel's funnel card is the authoritative source.
  console.log("\n=== funnel.user_registered by day (the 'new users' source) ===")
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = dayKey(utcDay(offset))
    const daily = await db.doc(`metrics_daily/${day}`).get()
    const data = (daily.data() ?? {}) as Record<string, unknown>
    const nested = (data["funnel"] as Record<string, number> | undefined)?.["user_registered"]
    const count = Number(nested ?? data["funnel.user_registered"] ?? 0)
    if (count) {
      console.log(`  ${day}  ${count}`)
    }
  }

  await reportSchemaProbe(db)

  if (totals.guests === null || totals.events === null) {
    console.error("\nAt least one collection could not be read — check credentials and the database name.")
    process.exit(1)
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`audit failed: ${message}`)
  if (/credential|default/i.test(message)) {
    console.error("Run: gcloud auth application-default login")
  }
  process.exit(1)
})
