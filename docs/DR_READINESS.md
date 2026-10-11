# DR readiness

Written 2026-10-11. **Nothing on this page is verifiable from the repository** --
the answers live in the Firebase, Upstash and Tigris consoles, which is exactly
why they were never written down. Each row gives the check, so the next reader
can turn "unstated" into an answer.

| Asset | What the repo shows | The check | Gap |
|---|---|---|---|
| Firestore | Rules, indexes and emulator config are in git. Data is not. | `gcloud firestore databases describe --project=libnet-d76db --format=json` -- read `pointInTimeRecoveryEnablement` (and `versionRetentionPeriod`). | No PITR is configured as far as this repo knows. A daily export to a bucket is the cheaper fallback if PITR is off. |
| Upstash Redis (`crawlcache`) | `functions/scripts/redis-hygiene.ts` audits keys and the analytics backlog. Nothing exports them. | Upstash console -> the `crawlcache` database -> Backups. | Caches and the presence index are rebuildable; the analytics queue is lossy by design. A backup buys little here -- decide that, do not assume a backup exists. |
| Tigris buckets | `blob-store.port.ts` has put/stat/list/signedUrl/delete. No lifecycle, no versioning, no snapshot tooling. | Tigris console -> bucket settings. | Objects hold crawl artifacts and vault payloads. `delete` is unconditional and irreversible (it is the GDPR purge path). |
| Firebase Auth users | `purgeOneAccount` deletes the user, three collections, their secrets and their blobs. | Firebase console -> Authentication -> Users (a deleted account is not listed, and is not restorable). | None. Deletion is meant to be irreversible; see below. |

## The tension worth deciding before anything is enabled

**Point-in-time recovery and bucket versioning reintroduce data that a GDPR
erasure already deleted.** A purge that ran on the 3rd is still inside a 7-day
PITR window on the 5th, and a versioned bucket still serves the pre-delete
object. So the two settings cannot both be "on by default and never discussed".
Pick one and write it here:

- PITR window **shorter than** the erasure SLA we publish, and versioning left
  off, **or**
- PITR on, and the privacy policy states the retention window for erased data.

## What is missing entirely

- **No restore drill has ever been run.** A backup nobody has restored from is a
  hypothesis. The cheapest drill: export one collection, import it into a
  scratch project, and delete the scratch project.
- **No owner.** This page is a checklist, not a schedule; backups that are not
  scheduled are not backups.
