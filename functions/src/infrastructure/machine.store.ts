/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The machine fleet, read ACROSS ALL TENANTS.
 *
 * Why this is a read and not a proxy
 * ---------------------------------
 * arachnefly owns the machine lifecycle and already has a cross-user query
 * (`GetAllMachinesGroupedByUser`), but it exposes no list ROUTE, and its
 * per-machine routes are ownership-checked. So the fleet view reads the same
 * Firestore collection arachnefly writes, rather than asking arachnefly for a
 * list it does not serve. Nothing here calls Fly.
 *
 * The projection is FIELD BY FIELD, and that is the security property
 * ----------------------------------------------------------------
 * A machine document carries `config.env` — the machine's environment variables,
 * which includes `WEBRAIN_HTTP_TOKEN`. That token is what authenticates the
 * engine on a publicly addressable machine, so handing a raw `doc.data()` to an
 * admin page would put every tenant's worker credential on screen, in a browser,
 * in a response body and in any proxy log between here and there.
 *
 * `FleetMachine` therefore has NO field a credential could occupy, and
 * `listFleetMachines` builds it by naming the fields it wants rather than by
 * spreading the document. Adding a field here is a deliberate act; it can never
 * happen by accident because the source object grew.
 *
 * The uid comes from the document PATH
 * -----------------------------------
 * `users/{uid}/machines/{machineId}`. `MachineInDB` has no `uid` field, because
 * the parent document already is that identity. Reading it from the path keeps
 * one copy instead of two that can disagree, exactly as
 * `listMeterableSessions` does for sessions. A document with no grandparent is
 * skipped rather than guessed at: an unattributable machine is one the operator
 * cannot act on, not one to fingerprint to a random tenant.
 *
 * Field names are arachnefly's, verified in `domain/machine.go` `MachineInDB`
 * and the writer at `interfaces/repository/firestore.go:CreateMachine`. They are
 * snake_case (`created_at`), NOT the camelCase the rest of this codebase uses,
 * and nothing enforces that agreement — the same cross-repo hazard the
 * `idleDeadline` field already carries.
 *
 * `created_at` is a STRING, not a timestamp
 * ----------------------------------------
 * `MachineInDB.CreatedAt string`. Fly returns RFC3339, which sorts correctly as
 * text, so `orderBy("created_at", "desc")` is meaningful. It is also why this
 * module never constructs a `Date` from it: the admin page formats it, and a
 * value that will not parse renders as itself rather than as `Invalid Date`.
 */
import {db} from "../app/config"
import {listSessionMachineIds} from "./browser-session.store"

/** The per-caller machine subcollection, as arachnefly names it. */
export const MACHINES_COLLECTION = "machines"

/**
 * How many machines one fleet read returns.
 *
 * A cap rather than a cursor. This is an operator console, not a paginated
 * customer surface, and an unbounded collection-group read is how one runaway
 * tenant turns the console into a timeout that looks like an outage. When the
 * fleet outgrows this the answer is a cursor, and the `truncated` flag exists so
 * the page can say "there are more" instead of quietly lying.
 */
export const FLEET_LIMIT = 500

/**
 * One machine, as the admin fleet view may see it.
 *
 * No `config`, no `env`, no `private_ip`. A private IP is not a credential, but
 * it is also not something an operator can act on from a browser, and every
 * field that is not needed is one that cannot leak.
 */
export interface FleetMachine {
  id: string
  uid: string
  name: string
  state: string
  region: string
  createdAt: string
  updatedAt: string
}

/**
 * The fleet page's reply.
 *
 * `truncated` rather than an error at the cap: a fleet of 501 machines is not a
 * failure, it is a fleet that needs a cursor, and the operator should be told
 * which of those two things they are looking at.
 */
export interface FleetReply {
  machines: FleetMachine[]
  truncated: boolean
}

/**
 * A stored value as a string, or an empty string.
 *
 * Tolerates a missing or wrongly-typed field instead of coercing it. `String()`
 * on an object would render `[object Object]` in the console, which reads like
 * data; an empty cell reads like a gap, which is what it is.
 * @param {unknown} value The stored value.
 * @return {string} The value when it is a string, otherwise empty.
 */
const asString = (value: unknown): string =>
  typeof value === "string" ? value : ""

/**
 * Every machine in the platform, newest first, with each owner.
 *
 * The only cross-tenant read of machines in this codebase, and it is deliberately
 * narrow: seven scalar fields, a hard cap, and no credential-bearing object
 * anywhere in the shape. The route in front of it is gated on `platform`
 * permission, which no role in `POLICIES` is granted, so `isPlatformAdmin` is
 * the only thing that can reach it.
 * @return {Promise<FleetReply>} The machines, and whether the cap was hit.
 */
export const listFleetMachines = async (): Promise<FleetReply> => {
  const snapshot = await db
    .collectionGroup(MACHINES_COLLECTION)
    .orderBy("created_at", "desc")
    .limit(FLEET_LIMIT + 1)
    .get()

  // One extra row is fetched so "there are more" is a fact rather than a guess
  // that the limit happened to be reached exactly.
  const truncated = snapshot.docs.length > FLEET_LIMIT
  const rows = truncated ? snapshot.docs.slice(0, FLEET_LIMIT) : snapshot.docs

  const machines: FleetMachine[] = []
  for (const doc of rows) {
    const uid = doc.ref.parent.parent?.id
    if (!uid) {
      continue
    }

    const raw = (doc.data() ?? {}) as Record<string, unknown>
    machines.push({
      id: asString(raw["id"]) || doc.id,
      uid: uid,
      name: asString(raw["name"]),
      state: asString(raw["state"]),
      region: asString(raw["region"]),
      createdAt: asString(raw["created_at"]),
      updatedAt: asString(raw["updated_at"]),
    })
  }

  return {machines: machines, truncated: truncated}
}

/** What a machine is being used for, which decides what may be done to it. */
export type MachineKind = "container" | "browser-session"

/**
 * One of the caller's own machines.
 *
 * `kind` is the field that makes a single surface safe. A container is driven by
 * the machine routes (start, suspend, stop, destroy, run-task); a browser-session
 * machine is owned by its session record and is released by the session's own
 * close route. Offering the container actions on a session's machine is how a
 * customer destroys a machine their session still bills for, so the client needs
 * to be told which is which rather than guessing from the name.
 *
 * No `config`, no `env`. Same reason as `FleetMachine`: `config.env` on a machine
 * document holds `WEBRAIN_HTTP_TOKEN`.
 */
export interface MineMachine {
  id: string
  name: string
  state: string
  region: string
  createdAt: string
  updatedAt: string
  kind: MachineKind
  /** The session that owns this machine, present only for a session machine. */
  sessionId?: string
}

/**
 * The caller's own machines, newest first, each marked with what it is for.
 *
 * This is a PLAIN COLLECTION query, not a collection-group one, because the caller
 * is known and their machines are one subcollection. That matters operationally:
 * Firestore auto-creates single-field indexes for collection-scope queries, so
 * ordering by `created_at` here needs NO declaration in `firestore.indexes.json`
 * and cannot fail with `FAILED_PRECONDITION` on a fresh project.
 *
 * `kind` comes from a JOIN against the caller's session records rather than from
 * the `bs-` machine-name prefix. The prefix is a convention with nothing enforcing
 * it, and this field decides whether a destructive action is offered, so it is
 * derived from the data that actually owns the machine.
 *
 * Scoped to one uid by construction: the caller supplies the uid from their
 * verified token, and this reads only that document's subcollection. There is no
 * parameter that could widen it.
 * @param {string} uid The verified caller uid.
 * @return {Promise<MineMachine[]>} The caller's machines, session machines marked.
 */
export const listMachinesForUser = async (
  uid: string,
): Promise<MineMachine[]> => {
  const [snapshot, sessions] = await Promise.all([
    db
      .collection("users")
      .doc(uid)
      .collection(MACHINES_COLLECTION)
      .orderBy("created_at", "desc")
      .limit(FLEET_LIMIT)
      .get(),
    listSessionMachineIds(uid),
  ])

  const machines: MineMachine[] = []
  for (const doc of snapshot.docs) {
    const raw = (doc.data() ?? {}) as Record<string, unknown>
    const id = asString(raw["id"]) || doc.id
    const sessionId = sessions[id]

    machines.push({
      id: id,
      name: asString(raw["name"]),
      state: asString(raw["state"]),
      region: asString(raw["region"]),
      createdAt: asString(raw["created_at"]),
      updatedAt: asString(raw["updated_at"]),
      kind: sessionId ? "browser-session" : "container",
      sessionId: sessionId,
    })
  }

  return machines
}
