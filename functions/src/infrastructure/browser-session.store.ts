/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * Where a browser session lives, and where a BYO CDP credential does.
 *
 * The same split as `storage-settings.store.ts`, for the same reason. The mode,
 * the kind, the state and the machine id are configuration and live in the
 * caller's document. A BYO CDP URL carries a token, so it is a credential: it
 * goes to Secret Manager through `upsertSecretValue`, and this document keeps
 * only `cdpSecretPath`. A Firestore document is backed up, exported and read by
 * rules, and none of those should be able to surface a credential.
 *
 * Every exported read returns `BrowserSessionPublic` or undefined, and
 * `toPublicSession` builds that shape field by field, so nothing
 * here can return
 * the secret pointer or the machine id.
 *
 * This module never reads the credential back.
 * The seam that does belongs to the
 * BYO adapter, with §1.7, and is the only place that should.
 */
import {randomUUID} from "node:crypto"
import {db, upsertSecretValue} from "../app/config"
import {
  BROWSER_KINDS,
  SESSION_CAPS,
  SESSION_STATES,
  cdpSecretId,
  decideCdpUrl,
  decideLease,
  idleDeadlineForTier,
  initialStateFor,
  toPublicSession,
  type BrowserKind,
  type BrowserSessionPublic,
  type BrowserSessionRecord,
  type BrowserTier,
  type LeaseRefusal,
  type SessionMode,
  type SessionState,
} from "../domain/browser-session.domain"

/** The per-caller subcollection, named once so a test or a rule can reuse it. */
export const BROWSER_SESSIONS_COLLECTION = "browserSessions"

/**
 * One caller's sessions.
 * @param {string} uid The verified caller uid.
 * @return {*} The Firestore collection reference.
 */
const sessionsRef = (uid: string) =>
  db.collection("users").doc(uid).collection(BROWSER_SESSIONS_COLLECTION)

/**
 * One session inside one caller's subcollection.
 * @param {string} uid The verified caller uid.
 * @param {string} id The session id.
 * @return {*} The Firestore document reference.
 */
const sessionRef = (uid: string, id: string) => sessionsRef(uid).doc(id)

/**
 * A finite number, or undefined when the value is anything else.
 * @param {*} value The untrusted value.
 * @return {number | undefined} The number, or undefined.
 */
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/**
 * A non-empty string, or undefined when the value is anything else.
 * @param {*} value The untrusted value.
 * @return {string | undefined} The string, or undefined.
 */
const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

/**
 * True when the value names a tier this build prices.
 *
 * Asked of `SESSION_CAPS` rather than a second list, so a tier cannot exist in
 * one place and not the other. `hasOwnProperty` keeps inherited keys such as
 * `constructor` from counting as a tier.
 * @param {*} value The untrusted value.
 * @return {boolean} True when the value is a priced tier.
 */
const isBrowserTier = (value: unknown): value is BrowserTier =>
  typeof value === "string" &&
  Object.prototype.hasOwnProperty.call(SESSION_CAPS, value)

/**
 * True when the value names a session state.
 * @param {*} value The untrusted value.
 * @return {boolean} True when the value is a session state.
 */
const isSessionState = (value: unknown): value is SessionState =>
  SESSION_STATES.includes(value as SessionState)

/**
 * True when the value names an engine we can drive.
 * @param {*} value The untrusted value.
 * @return {boolean} True when the value is a supported engine.
 */
const isBrowserKind = (value: unknown): value is BrowserKind =>
  BROWSER_KINDS.includes(value as BrowserKind)

/**
 * Read one stored document, or undefined when it cannot be trusted.
 *
 * Firestore is a store, not a validator: a hand-edited or legacy document must
 * not become a session state, so every field is checked rather than cast.
 *
 * Unknown fields are ignored ON PURPOSE -- a newer build writes one mid-deploy
 * and this build still reads the session -- while an unknown `state`/`tier`/
 * `kind`/`mode` fails closed. That pair is why nothing here is versioned: a `v`
 * field could only tell those two cases apart in order to do exactly this. See
 * docs/ADR-2026-10-DURABLE-SHAPE-DISCIPLINE.md.
 * @param {string} id The document id.
 * @param {Record<string, unknown>} data The raw document.
 * @return {BrowserSessionRecord | undefined} The record, or undefined.
 */
export const parseSession = (
  id: string,
  data: Record<string, unknown>,
): BrowserSessionRecord | undefined => {
  const createdAt = asNumber(data.createdAt)
  const lastUsedAt = asNumber(data.lastUsedAt)
  if (createdAt === undefined || lastUsedAt === undefined) {
    return undefined
  }
  if (!isBrowserTier(data.tier) || !isSessionState(data.state)) {
    return undefined
  }
  if (!isBrowserKind(data.kind)) {
    return undefined
  }
  if (data.mode !== "dedicated" && data.mode !== "byo") {
    return undefined
  }

  const record: BrowserSessionRecord = {
    id,
    mode: data.mode,
    kind: data.kind,
    state: data.state,
    tier: data.tier,
    createdAt,
    lastUsedAt,
    minutesBilled: asNumber(data.minutesBilled) ?? 0,
  }

  const machineId = asNonEmptyString(data.machineId)
  if (machineId) {
    record.machineId = machineId
  }
  const cdpSecretPath = asNonEmptyString(data.cdpSecretPath)
  if (cdpSecretPath) {
    record.cdpSecretPath = cdpSecretPath
  }
  const idleDeadline = asNumber(data.idleDeadline)
  if (idleDeadline !== undefined) {
    record.idleDeadline = idleDeadline
  }

  return record
}

/** What a caller must supply to open a session. */
export type CreateBrowserSessionInput = {
  uid: string
  tier: BrowserTier
  mode: SessionMode
  kind: BrowserKind
  /** Required for `byo`, ignored otherwise. Untrusted: vetted below. */
  cdpUrl?: unknown
  /** Epoch ms, passed in so this module owns no clock. */
  now: number
}

/** The new session, or the one reason it was refused. */
export type CreateBrowserSessionResult =
  | {ok: true; session: BrowserSessionPublic}
  | {ok: false; reason: LeaseRefusal}

/**
 * Open a session, atomically with the quota check that allows it.
 *
 * The count and the write are in one transaction, and that is the whole point of
 * this function. They used to be two steps in the route: read the live sessions,
 * decide, then write. Two concurrent requests both read the same count, both
 * passed `decideLease`, and both wrote — so a tier capped at one dedicated
 * session could end up holding several, each with its own Fly machine. A cap a
 * caller can exceed by double-submitting is not a cap, and what it fails to bound
 * is real money on platform compute.
 *
 * Reading the caller's subcollection inside the transaction is what makes it
 * atomic: a concurrent insert changes the result of that read, so Firestore
 * aborts and replays the second transaction, which then sees the first session
 * and refuses with `quota`. The body is therefore re-run from the top on
 * contention — which is why nothing with a side effect may live inside it.
 *
 * The `byo` credential work stays outside for exactly that reason. Vetting is
 * pure, but `upsertSecretValue` talks to Secret Manager, and a transaction body
 * that wrote a secret would write it once per retry. So a request that loses the
 * race to `quota` has already stored its endpoint — under the caller's own uid,
 * at a path keyed by uid, with the value they just sent. That is a benign side
 * effect rather than a leak, and it is the price of keeping all I/O out of the
 * transaction.
 *
 * The route still pre-flights `decideLease` before calling this. That is not the
 * enforcement — this is — and it is kept for two reasons: it preserves the order
 * refusals are reported in, and it avoids writing a credential for a request that
 * is refused outright. The decision is re-run here rather than a count being
 * passed in, because a count passed in was read before the transaction and would
 * reopen the race this function exists to close.
 * @param {CreateBrowserSessionInput} input The request.
 * @return {Promise<CreateBrowserSessionResult>} The session, or the refusal.
 */
export const createBrowserSession = async (
  input: CreateBrowserSessionInput,
): Promise<CreateBrowserSessionResult> => {
  let cdpSecretPath: string | undefined
  if (input.mode === "byo") {
    const vetted = decideCdpUrl(input.cdpUrl)
    if (!vetted.ok) {
      return {ok: false, reason: vetted.reason}
    }
    cdpSecretPath = await upsertSecretValue(cdpSecretId(input.uid), vetted.url)
  }

  const id = randomUUID()
  const record: BrowserSessionRecord = {
    id,
    mode: input.mode,
    kind: input.kind,
    state: initialStateFor(input.mode),
    tier: input.tier,
    createdAt: input.now,
    lastUsedAt: input.now,
    minutesBilled: 0,
  }
  if (cdpSecretPath) {
    record.cdpSecretPath = cdpSecretPath
  }
  const idleDeadline = idleDeadlineForTier(input.tier, input.now)
  if (idleDeadline !== undefined) {
    record.idleDeadline = idleDeadline
  }

  return db.runTransaction<CreateBrowserSessionResult>(
    async (transaction) => {
      const snapshot = await transaction.get(sessionsRef(input.uid))

      const decision = decideLease({
        tier: input.tier,
        mode: input.mode,
        kind: input.kind,
        liveSessions: countLive(snapshot),
        // The route's reading of this, restated rather than inferred: the
        // endpoint is configured BY this request when it carries one, and this
        // module never reads a stored credential back to find out.
        byoConfigured: input.mode === "byo" && input.cdpUrl !== undefined,
      })
      if (!decision.ok) {
        return {ok: false, reason: decision.reason}
      }

      transaction.set(sessionRef(input.uid, id), record)
      return {ok: true, session: toPublicSession(record)}
    },
  )
}

/**
 * One session as STORED, including the fields no route may answer with.
 *
 * The same read as `listBrowserSessions` minus the projection, which is why it
 * must never leave the server. It exists for exactly one caller: closing a
 * session has to know whether a machine is attached before it can release it,
 * and `machineId` is deliberately absent from `BrowserSessionPublic`.
 *
 * This replaced an exported `readBrowserSession` that nothing called. If a route
 * ever wants this shape, that is the signal `BrowserSessionPublic` is missing a
 * field — not that this should be returned.
 * @param {string} uid The verified caller uid.
 * @param {string} id The session id.
 * @return {Promise<BrowserSessionRecord | undefined>} The record, if owned.
 */
export const readBrowserSessionRecord = async (
  uid: string,
  id: string,
): Promise<BrowserSessionRecord | undefined> => {
  const snapshot = await sessionRef(uid, id).get()
  if (!snapshot.exists) {
    return undefined
  }
  const raw = (snapshot.data() ?? {}) as Record<string, unknown>
  return parseSession(id, raw)
}

/**
 * A stored record that still counts against this caller's quota.
 *
 * A type predicate rather than a plain boolean so a caller can use it in a
 * condition and keep the narrowing, which is what lets the two call sites below
 * skip their own `record !== undefined` check.
 * @param {BrowserSessionRecord | undefined} record The parsed record.
 * @return {boolean} True when the session is live.
 */
const isLive = (
  record: BrowserSessionRecord | undefined,
): record is BrowserSessionRecord =>
  record !== undefined && record.state !== "closed"

/** The only part of a Firestore query snapshot the counter reads. */
type DocsSnapshot = {docs: {id: string, data: () => unknown}[]}

/**
 * Count the documents in a snapshot that are live.
 *
 * Typed structurally rather than with Firestore's `QuerySnapshot` so this file
 * needs no Admin SDK type import for it: the only things touched are `.docs` and
 * each document's `id` and `data()`.
 *
 * This exists so the filter is written ONCE. It is used both by the listing read
 * and by the count taken inside the create transaction, and those two must agree
 * — if they ever drifted, the transactional check would enforce a different rule
 * from the one the route pre-flights with.
 * @param {DocsSnapshot} snapshot A query snapshot of one caller's sessions.
 * @return {number} How many are live.
 */
const countLive = (snapshot: DocsSnapshot): number => {
  let live = 0
  for (const doc of snapshot.docs) {
    const raw = (doc.data() ?? {}) as Record<string, unknown>
    if (isLive(parseSession(doc.id, raw))) {
      live += 1
    }
  }
  return live
}

/**
 * Every session this caller still holds, oldest first.
 *
 * `closed` is excluded on purpose: that is the same set `decideLease` counts as
 * `liveSessions`, so a route can feed this straight into the decision.
 * @param {string} uid The verified caller uid.
 * @return {Promise<BrowserSessionPublic[]>} The live sessions.
 */
export const listBrowserSessions = async (
  uid: string,
): Promise<BrowserSessionPublic[]> => {
  const snapshot = await sessionsRef(uid).get()
  const sessions: BrowserSessionPublic[] = []

  for (const doc of snapshot.docs) {
    const raw = (doc.data() ?? {}) as Record<string, unknown>
    const record = parseSession(doc.id, raw)
    if (isLive(record)) {
      sessions.push(toPublicSession(record))
    }
  }

  return sessions.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * The states a meter sweep still has to look at.
 *
 * `closed` is excluded, and that exclusion is a KNOWN REVENUE GAP rather than an
 * oversight: a session that closes between two sweeps is never charged for its
 * final block, because closing does not itself perform a meter charge. Deriving
 * this from `SESSION_STATES` rather than listing the three by hand means a new
 * state is metered by default instead of silently escaping.
 */
const METERABLE_STATES = SESSION_STATES.filter((state) => state !== "closed")

/** A session the meter may still owe for, with the caller it belongs to. */
export type MeterableSession = {
  /** The owning uid, taken from the document path — the record has no uid. */
  uid: string
  record: BrowserSessionRecord
}

/**
 * Every session the meter may still owe for, ACROSS ALL CALLERS.
 *
 * The only cross-user read in this file, and it exists because a scheduled
 * sweep has no `uid` to start from: `listBrowserSessions` is per-caller by
 * construction, so a meter built on it could never see the sessions it exists to
 * bill. This is a collection-group query, which is why it needs a
 * collection-group index on `state` — declared in `firestore.indexes.json`
 * beside the `idleDeadline` index the Go reaper uses.
 *
 * The uid is read from the document path. `BrowserSessionRecord` deliberately
 * has no `uid` field: it is the parent document's identity, and duplicating it
 * into the record would create a second copy that could disagree with the path
 * the security rules enforce.
 *
 * A document whose path has no grandparent is skipped rather than guessed at.
 * That should be unreachable, and dropping it is the safe direction: an
 * unattributable session is one the meter cannot charge, not one it should
 * charge to an arbitrary caller.
 * @return {Promise<MeterableSession[]>} Every non-closed session, all callers.
 */
export const listMeterableSessions = async (): Promise<MeterableSession[]> => {
  const snapshot = await db
    .collectionGroup(BROWSER_SESSIONS_COLLECTION)
    .where("state", "in", METERABLE_STATES)
    .get()

  const sessions: MeterableSession[] = []
  for (const doc of snapshot.docs) {
    const uid = doc.ref.parent.parent?.id
    if (!uid) {
      continue
    }
    const raw = (doc.data() ?? {}) as Record<string, unknown>
    const record = parseSession(doc.id, raw)
    // `isLive` rather than a cast, so the in-memory test is the same predicate
    // the rest of this file uses. It also drops a document that failed to parse,
    // which a cast would have handed on as a record full of undefined fields.
    if (!isLive(record)) {
      continue
    }
    sessions.push({uid, record})
  }

  return sessions
}

/**
 * How many live sessions one console read returns.
 *
 * A CAP rather than a page size, and the query below deliberately has no
 * `orderBy`. Ordering by `lastUsedAt` beside a `state in [...]` filter needs a
 * COMPOSITE collection-group index, and an undeployed index answers
 * `FAILED_PRECONDITION` — which the console would render as "no sessions", the
 * same looks-like-an-empty-list failure the machine fleet view was built to
 * avoid. So this reuses the `state` index that already exists and reports
 * truncation instead.
 *
 * ponytail: an arbitrary page at the cap, not the most idle. Add the composite
 * index and an `orderBy` when a live fleet actually exceeds this.
 */
export const ADMIN_SESSION_LIMIT = 500

/**
 * One live session, as the platform console may see it.
 *
 * Field by field rather than a spread of `BrowserSessionRecord`, for the same
 * reason `FleetMachine` names its own fields: the record carries
 * `cdpSecretPath`, the Secret Manager path holding a BYO endpoint's credential.
 * It is a path rather than the secret itself, and the console has no use for it,
 * so this shape has no field it could occupy.
 */
export type AdminSession = {
  /** The owning uid, from the document path — the record has none by design. */
  uid: string
  id: string
  mode: BrowserSessionRecord["mode"]
  kind: BrowserSessionRecord["kind"]
  state: BrowserSessionRecord["state"]
  tier: BrowserSessionRecord["tier"]
  createdAt: number
  lastUsedAt: number
  minutesBilled: number
  /** Absent for a BYO session: there is no platform machine to release. */
  machineId?: string
}

/**
 * Project one record into the console's shape, dropping what it must not carry.
 * @param {string} uid The owning uid, taken from the document path.
 * @param {BrowserSessionRecord} record The internal record.
 * @return {AdminSession} The projected session.
 */
const toAdminSession = (
  uid: string,
  record: BrowserSessionRecord,
): AdminSession => {
  const session: AdminSession = {
    uid,
    id: record.id,
    mode: record.mode,
    kind: record.kind,
    state: record.state,
    tier: record.tier,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    minutesBilled: record.minutesBilled,
  }
  if (record.machineId) {
    session.machineId = record.machineId
  }
  return session
}

/** The console's reply. `truncated` at the cap, never an error. */
export interface AdminSessionReply {
  sessions: AdminSession[]
  truncated: boolean
}

/**
 * Every live session ACROSS ALL CALLERS, for the platform console.
 *
 * A collection-group read like `listMeterableSessions`, reusing the SAME `state`
 * filter, so it needs no new index. `closed` is excluded for the reason the
 * meter excludes it: a closed session holds no machine and bills nothing, so
 * listing it would offer an operator a row with nothing behind it.
 *
 * `idleDeadline` is NOT projected. It is a machine-side deadline the Go reaper
 * reads, whereas an idle TIME is derived from `lastUsedAt`. They are different
 * facts, and rendering the deadline as activity would mislabel it.
 * @return {Promise<AdminSessionReply>} The live sessions, and whether the cap hit.
 */
export const listAdminSessions = async (): Promise<AdminSessionReply> => {
  const snapshot = await db
    .collectionGroup(BROWSER_SESSIONS_COLLECTION)
    .where("state", "in", METERABLE_STATES)
    .limit(ADMIN_SESSION_LIMIT + 1)
    .get()

  // `+ 1` so a fleet sitting exactly on the cap is not reported as truncated.
  const truncated = snapshot.docs.length > ADMIN_SESSION_LIMIT
  const rows = truncated ?
    snapshot.docs.slice(0, ADMIN_SESSION_LIMIT) : snapshot.docs

  const sessions: AdminSession[] = []
  for (const doc of rows) {
    const uid = doc.ref.parent.parent?.id
    if (!uid) {
      continue
    }
    const raw = (doc.data() ?? {}) as Record<string, unknown>
    const record = parseSession(doc.id, raw)
    // A document that failed to parse is dropped rather than guessed at, the
    // same direction `listMeterableSessions` takes: an unattributable session is
    // one the console cannot describe, not one it should invent fields for.
    if (!record) {
      continue
    }
    sessions.push(toAdminSession(uid, record))
  }

  return {sessions: sessions, truncated: truncated}
}

/**
 * The machine each live session holds, as `machineId` -> `sessionId`.
 *
 * SERVER-SIDE ONLY, and that is why it exists. `BrowserSessionPublic` has no
 * `machineId` field on purpose, so the ordinary read cannot answer "which of my
 * machines is a browser session's?" -- and the only other way to answer it is to
 * parse the `bs-<sessionId>` machine NAME, which is a convention with nothing
 * enforcing it. A rename or a clone would silently break the answer, and the
 * answer decides whether a destructive action is offered. So the join reads the
 * internal record instead.
 *
 * A `closed` session is skipped: its machine is released on close, so the machine
 * is a container again rather than something a session owns.
 * @param {string} uid The verified caller uid.
 * @return {Promise<Record<string, string>>} Machine id to session id.
 */
export const listSessionMachineIds = async (
  uid: string,
): Promise<Record<string, string>> => {
  const snapshot = await sessionsRef(uid).get()
  const owned: Record<string, string> = {}

  for (const doc of snapshot.docs) {
    const raw = (doc.data() ?? {}) as Record<string, unknown>
    const machineId = typeof raw["machineId"] === "string" ? raw["machineId"] : ""
    const state = typeof raw["state"] === "string" ? raw["state"] : ""
    if (!machineId || state === "closed") {
      continue
    }

    owned[machineId] = doc.id
  }

  return owned
}

/**
 * Advance a session's billed-minutes counter, monotonically.
 *
 * Monotonic on purpose. The counter is what tells the next sweep which blocks
 * are already paid for, so a straggling run that finished late must not be able
 * to rewind it: a rewound counter re-emits keys for blocks the ledger has
 * already applied, which is not a double charge (the idempotency key prevents
 * that) but is ledger churn and a lying counter.
 *
 * Reads and compares inside a transaction for the same reason — two sweeps
 * overlapping at a block boundary would otherwise settle on whichever wrote
 * last rather than on the larger value.
 * @param {string} uid The owning caller.
 * @param {string} id The session id.
 * @param {number} minutes The minutes to record, if larger than what is stored.
 * @return {Promise<void>} Resolves once the counter is at least `minutes`.
 */
export const recordMeteredMinutes = async (
  uid: string,
  id: string,
  minutes: number,
): Promise<void> => {
  if (!Number.isFinite(minutes)) {
    return
  }

  const ref = sessionRef(uid, id)
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) {
      return
    }
    const raw = (snapshot.data() ?? {}) as Record<string, unknown>
    const current = asNumber(raw["minutesBilled"]) ?? 0
    if (minutes <= current) {
      return
    }
    transaction.set(ref, {minutesBilled: minutes}, {merge: true})
  })
}

/**
 * End a session by moving its idle deadline to now.
 *
 * The meter calls this once a session has used its whole allowance. The machine
 * is NOT suspended here and cannot be: arachnefly's `FireAuthMiddleware` accepts
 * only a Firebase ID token, so a scheduled job has no owner to authenticate as.
 * That is the same Phase 0 item 4 constraint that put the reaper in Go, and it
 * applies to the meter for the same reason.
 *
 * Moving the deadline is how the sweep asks the reaper to act. The reaper
 * already suspends machines at their deadline every minute, so this needs no new
 * mechanism, no new state, and no second way for a session to end. It also keeps
 * the session VISIBLE: an expired open session is exactly what the reaper looks
 * for, whereas a `closed` record is skipped by design and would strand the
 * machine.
 *
 * The write only ever brings a deadline FORWARD, and a session with no deadline
 * at all is left alone. `free` and `admin` have no idle expiry, and inventing one
 * for them here would give a tier a behaviour it does not have anywhere else.
 * @param {string} uid The owning caller.
 * @param {string} id The session id.
 * @param {number} now Epoch ms to move the deadline to.
 * @return {Promise<void>} Resolves once the deadline is at or before `now`.
 */
export const expireMeteredSession = async (
  uid: string,
  id: string,
  now: number,
): Promise<void> => {
  const ref = sessionRef(uid, id)
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) {
      return
    }
    const raw = (snapshot.data() ?? {}) as Record<string, unknown>
    if (raw["state"] === "closed") {
      return
    }
    const current = asNumber(raw["idleDeadline"])
    if (current === undefined || current <= now) {
      return
    }
    transaction.set(ref, {idleDeadline: now}, {merge: true})
  })
}

/**
 * Record activity and push the idle deadline out.
 *
 * A closed session is not revived: this answers undefined so a keepalive after a
 * close reads as "not found" rather than silently reopening a record the caller
 * already ended.
 * @param {string} uid The verified caller uid.
 * @param {string} id The session id.
 * @param {number} now Epoch ms of this activity.
 * @return {Promise<BrowserSessionPublic | undefined>} The session, if live.
 */
export const keepaliveBrowserSession = async (
  uid: string,
  id: string,
  now: number,
): Promise<BrowserSessionPublic | undefined> => {
  const ref = sessionRef(uid, id)
  const snapshot = await ref.get()
  if (!snapshot.exists) {
    return undefined
  }
  const raw = (snapshot.data() ?? {}) as Record<string, unknown>
  const record = parseSession(id, raw)
  if (!record || record.state === "closed") {
    return undefined
  }

  const updates: Record<string, unknown> = {lastUsedAt: now}
  const idleDeadline = idleDeadlineForTier(record.tier, now)
  if (idleDeadline !== undefined) {
    updates.idleDeadline = idleDeadline
  }
  await ref.set(updates, {merge: true})

  const updated: BrowserSessionRecord = {...record, lastUsedAt: now}
  if (idleDeadline !== undefined) {
    updated.idleDeadline = idleDeadline
  }
  return toPublicSession(updated)
}

/**
 * Record the machine a session was given, and mark the session provisioned.
 *
 * The state moves to `ready` here, and that word is doing less work than it
 * looks: it means *this session has a machine*, not *the container is accepting
 * connections*. arachnefly answers only once Fly has created the machine, whose
 * guest may still be booting, and there is nothing on this side that could tell
 * the difference. The alternative — leaving every session in `starting` forever,
 * because nothing else ever writes `ready` — is a dead end in the state machine,
 * so `ready` is the honest place to stop.
 *
 * The machine id is **not** overwritten when one is already present. First
 * attachment wins, because a second id would strand the first machine with
 * nothing pointing at it, and the reaper finds machines only through sessions.
 *
 * A closed session is not revived, matching `keepaliveBrowserSession`: a deploy
 * that finished after the caller gave up answers undefined rather than
 * reopening a record they already ended.
 * @param {string} uid The verified caller uid.
 * @param {string} id The session id.
 * @param {string} machineId The Fly machine id arachnefly returned.
 * @param {number} now Epoch ms the machine was attached.
 * @return {Promise<BrowserSessionPublic | undefined>} The session, if attachable.
 */
export const attachMachine = async (
  uid: string,
  id: string,
  machineId: string,
  now: number,
): Promise<BrowserSessionPublic | undefined> => {
  const ref = sessionRef(uid, id)
  const snapshot = await ref.get()
  if (!snapshot.exists) {
    return undefined
  }
  const raw = (snapshot.data() ?? {}) as Record<string, unknown>
  const record = parseSession(id, raw)
  if (!record || record.state === "closed") {
    return undefined
  }

  if (record.machineId) {
    return toPublicSession(record)
  }

  const updates: Record<string, unknown> = {
    machineId: machineId,
    state: "ready",
    lastUsedAt: now,
  }
  const idleDeadline = idleDeadlineForTier(record.tier, now)
  if (idleDeadline !== undefined) {
    updates.idleDeadline = idleDeadline
  }
  await ref.set(updates, {merge: true})

  const updated: BrowserSessionRecord = {
    ...record,
    machineId: machineId,
    state: "ready",
    lastUsedAt: now,
  }
  if (idleDeadline !== undefined) {
    updated.idleDeadline = idleDeadline
  }
  return toPublicSession(updated)
}

/**
 * End a session. Idempotent: closing a closed session returns it.
 *
 * The BYO credential is deliberately **not** purged here. It is the caller's
 * per-user configuration and other sessions may still be attached to it, so
 * purging on one session's close would break them; clearing BYO config is a
 * separate operation.
 * @param {string} uid The verified caller uid.
 * @param {string} id The session id.
 * @param {number} now Epoch ms of the close.
 * @return {Promise<BrowserSessionPublic | undefined>} The closed session.
 */
export const closeBrowserSession = async (
  uid: string,
  id: string,
  now: number,
): Promise<BrowserSessionPublic | undefined> => {
  const ref = sessionRef(uid, id)
  const snapshot = await ref.get()
  if (!snapshot.exists) {
    return undefined
  }
  const raw = (snapshot.data() ?? {}) as Record<string, unknown>
  const record = parseSession(id, raw)
  if (!record) {
    return undefined
  }

  await ref.set({state: "closed", lastUsedAt: now}, {merge: true})

  return toPublicSession({...record, state: "closed", lastUsedAt: now})
}
