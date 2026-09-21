# ADR 2026-09 — Search and indexing over the `easyscrape` database

Status: **Accepted** (decision taken while the requester was unavailable; revisit when a search
requirement actually exists).

## Context

The Firebase console shows the Algolia extension `algolia/firestore-algolia-search@1.3.0` installed
on `libnet-d76db`. It was asked to be re-pointed at the `easyscrape` database and extended to index
"any kind of collection we need to search".

## Findings

1. **The existing instance cannot be re-pointed.** In `extension.yaml` (v1.3.0) both relevant
   parameters are `immutable: true`:

   ```yaml
   - param: DATABASE_ID
     default: '(default)'
     immutable: true
   - param: COLLECTION_PATH
     immutable: true
   ```

   The trigger is `projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/${COLLECTION_PATH}/{documentID}`.
   Changing the database means uninstall + reinstall, and **one instance watches exactly one
   collection path** — N collections means N instances, N Algolia indexes and 2 functions each.

2. **The platform is being retired.** Extensions Hub states: *"Firebase Extensions will shut down
   on March 31, 2027. You will not be able to install or edit extensions after this date. We will
   share migration guidance and tools in September 2026."* Installing more instances now means
   building on something with a known expiry.

3. **Nothing consumes Algolia.** `algolia` matches nowhere in `src/` or `package.json` (only
   transitively in `package-lock.json`), and there is no search UI (no `searchQuery`, `onSearch`,
   `SearchService`, `performSearch`). The instance is console-managed — there is no `extensions`
   block in `firebase.json`, so it is neither reproducible nor reviewable from the repo.

4. **Firestore composite indexes are not search.** They serve filtered/sorted queries. Full-text
   search needs an external index fed by triggers. `firestore.indexes.json` already declares 38
   indexes for real query paths; adding speculative ones costs write amplification for nothing.

5. **The project has four databases:** `easyscrape` (nam5), `auth0` (nam5), `(default)` (eur3) and
   `supply` (eur3). Application data is in `easyscrape` — `firebase.json` pins it, the client asks
   for it explicitly, and the BFF/functions default to it.

## Decision

- **Do not install or re-point extension instances.** The mutable-configuration surface is the
  wrong shape for "index many collections", and the platform has a shutdown date.
- **Do not add Firestore indexes speculatively.** Add them when a specific query needs them.
- **If search becomes a requirement**, index `easyscrape` → Algolia from our own Firestore
  triggers in `functions/src/gfunctions/`: one function per collection (or one fan-out function
  writing to per-collection indexes), Cloud Functions `onDocumentWritten` with
  `database: "easyscrape"`, reusing the alert-fanout pattern. That works with the named database,
  has no expiry, and lives in code review.

## Consequences

- Search remains unimplemented. That is deliberate: the gap is a missing requirement, not a
  missing extension.
- The misconfigured extension instance keeps running until someone removes it from the console.
  It is not referenced anywhere in this repository.

## Bug found while auditing this

Auditing which database the app actually talks to uncovered a live mismatch, fixed in the same
change: `app.config.ts` provided `getFirestore()` **without a database id**, so the injected
`Firestore` token resolved to `(default)`. Consumers of that token were:

- `NotificationBellComponent` — listened on `users/{uid}/alerts` and `billing_incidents` in
  `(default)`, while `alert-fanout.ts` writes alerts to `easyscrape` with
  `database: DATABASE_NAME`. The bell could never fire.
- `FirestoreAnalyticsService` — read `metrics_summary`, `metrics_daily`, `metrics_range` from
  `(default)` while the rollups are written to `easyscrape`. The admin dashboard read empty.

`functions/scripts/analytics-audit-cli.ts` already documents this failure mode: *"Defaulting to
`(default)` here is what produced the past FAILED_PRECONDITION incident."* The client-side service
was never given the same treatment. The provider now asks for `easyscrape`, which fixes every
consumer at once — including `paymentmethods` and `signup`, which inject the same token.
