/* eslint-disable require-jsdoc */
/* eslint-disable max-len */
/**
 * Read-only probe for the "last 24h" admin panel.
 *
 * `analytics-audit-cli.ts` covers `metrics_daily` / `metrics_range` / the summary,
 * but the 24h and 1h periods are built by `buildHourlyRangeMetrics`, which reads
 * `metrics_hourly` and merges the same 22 dimensions. When those maps are absent
 * the panels render only their fallback label at 0% ("Unknown IP", "direct", "/"),
 * which is indistinguishable from "no traffic" in the UI.
 *
 * Answers: do the hourly rows carry the breakdown dimensions at all, and do recent
 * guest docs carry the geo fields (i.e. is the empty panel a write-side or a
 * read-side problem)?
 *
 * Usage: npx tsx scripts/analytics-hourly-probe.ts
 * Credentials: Application Default Credentials. No secrets are read or printed.
 */

import {applicationDefault, getApps, initializeApp} from "firebase-admin/app"
import {getFirestore} from "firebase-admin/firestore"

/* eslint-disable @typescript-eslint/no-explicit-any */
// dotenvx leaves `encrypted:…` ciphertext in the environment locally; trusting one
// as a project id yields PERMISSION_DENIED on a project that does not exist. Same
// guard as analytics-audit-cli.ts.
const usableId = (value: string | undefined, shape: RegExp): string | null => {
  const trimmed = (value || "").trim()
  return !trimmed || /^encrypted:/i.test(trimmed) || !shape.test(trimmed) ? null : trimmed
}

const app = getApps().length ? getApps()[0] : initializeApp({
  credential: applicationDefault(),
  projectId: usableId(process.env["GCLOUD_PROJECT"], /^[a-z][a-z0-9-]{4,29}$/) ||
    usableId(process.env["GCP_PROJECT_ID"], /^[a-z][a-z0-9-]{4,29}$/) ||
    "libnet-d76db",
})
const db = getFirestore(app, usableId(process.env["FIRESTORE_DB_ID"], /^[a-z][a-z0-9-]{2,29}$/) || "easyscrape")

const DIMS = [
  "byOS", "byCountry", "byBrowser", "byDevice", "byTimezone", "byProvider",
  "byRegion", "byLanguage", "byIP", "byASN", "byISP", "byChannel",
  "byReferrer", "byProxyType", "byBotKind", "clientEvents", "byPage",
  "byLandingPath", "byGeoCell",
]

// const dottedGroups = (data: Record<string, any>): string[] => {
//   const out = new Set<string>()
//   for (const key of Object.keys(data)) {
//     if (key.includes(".")) out.add(key.split(".")[0])
//   }
//   return [...out].sort()
// }

async function main() {
  // Direct id reads: `metrics_hourly/{YYYY-MM-DD-HH}`. A query on this collection
  // wants a composite index that does not exist in this project.
  const now = new Date()
  const hourKeys = Array.from({length: 8}, (_, i) => {
    const d = new Date(now.getTime() - (i + 1) * 3600_000)
    return `${d.toISOString().slice(0, 10)}-${String(d.getUTCHours()).padStart(2, "0")}`
  })
  console.log("=== metrics_hourly (last 8 hour keys) ===")
  for (const id of hourKeys) {
    const snap = await db.doc(`metrics_hourly/${id}`).get()
    if (!snap.exists) {
      console.log(`  ${id}  (missing)`)
      continue
    }
    const data = snap.data() as Record<string, any>
    const present = DIMS.filter((d) => Object.keys(data).some((k) => k === d || k.startsWith(`${d}.`)))
    const sample: string[] = []
    for (const d of ["byBrowser", "byCountry", "byIP", "byASN", "byOS"]) {
      const keys = Object.keys(data).filter((k) => k.startsWith(`${d}.`))
      if (keys.length) sample.push(`${d}[${keys.length}]: ${keys.slice(0, 2).map((k) => `${k.slice(d.length + 1)}=${data[k]}`).join(", ")}`)
    }
    console.log(`  ${id}  fields=${Object.keys(data).length}`)
    console.log(`     dims written: ${present.join(", ") || "(none)"}`)
    console.log(`     sample: ${sample.join(" | ") || "(no dim maps)"}`)
  }

  console.log("=== metrics_daily (today / yesterday) ===")
  for (const id of [now.toISOString().slice(0, 10), new Date(now.getTime() - 86400_000).toISOString().slice(0, 10)]) {
    const snap = await db.doc(`metrics_daily/${id}`).get()
    if (!snap.exists) {
      console.log(`  ${id} (missing)`); continue
    }
    const data = snap.data() as Record<string, any>
    const present = DIMS.filter((d) => Object.keys(data).some((k) => k === d || k.startsWith(`${d}.`)))
    console.log(`  ${id} dims: ${present.join(", ") || "(none)"}`)
  }

  const guests = await db.collection("guests").orderBy("lastSeen", "desc").limit(5).get()
  console.log("=== guests (newest 5 by lastSeen) — shape + geo ===")
  for (const doc of guests.docs) {
    const d = doc.data() as Record<string, any>
    const geo = d.geo || d.location || {}
    const createdAt = d.createdAt as { toDate?: () => Date } | string | undefined
    const createdIso = createdAt && typeof createdAt === "object" && createdAt.toDate ? createdAt.toDate().toISOString() : String(createdAt ?? "(absent)")
    console.log(`  ${doc.id}`)
    console.log(`     createdAt=${createdIso}  lastSeen=${String((d.lastSeen as any)?.toDate ? (d.lastSeen as any).toDate().toISOString() : d.lastSeen ?? "-")}`)
    console.log(`     country=${d.country ?? geo.countryCode ?? "-"} region=${d.region ?? geo.region ?? "-"} tz=${d.timezone ?? geo.timeZoneName ?? "-"} browser=${d.browser ?? "-"} os=${d.os ?? "-"} device=${d.device ?? "-"} lang=${d.language ?? "-"}`)
    console.log(`     fields(${Object.keys(d).length}): ${Object.keys(d).sort().join(",")}`)
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e); process.exit(1)
})
