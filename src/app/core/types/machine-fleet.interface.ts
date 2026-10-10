/**
 * The machine fleet, as the platform admin console sees it.
 *
 * This is the ADMIN projection, not the tenant one. `DeploymentService` talks to
 * `/api/machines/*` for a caller's own machines; this talks to
 * `/api/admin/machines` for every machine in the platform. The two are separate
 * on the server for a reason that is not cosmetic: the tenant routes are gated
 * `perm('machine', ...)`, which every paid customer holds, while this one is
 * gated `perm('platform', 'read')`, which is granted to no role and is admitted
 * only by the platform-admin short-circuit. Putting them behind one client
 * method would invite the same gate on both.
 *
 * There is no `config`, no `env` and no `privateIp` field, and that is the
 * point rather than an omission. A machine document carries `config.env`, which
 * holds `WEBRAIN_HTTP_TOKEN` -- the credential that authenticates the engine on
 * a publicly addressable machine. A type that offered a field for it would be
 * inviting someone to ask the server for it. The server refuses to send it, and
 * this shape is the second half of that refusal.
 *
 * `state` is a STRING, not a union of Fly's states
 * ----------------------------------------------
 * Tempting to narrow, and wrong here. The values come from
 * `github.com/sosedoff/fly-machines` on arachnefly's side and include at least
 * `created`, `starting`, `started`, `stopping`, `stopped`, `suspended`,
 * `destroying`, `replaced`, plus arachnefly's own `inactive`. Nothing enforces
 * that this list agrees with Fly's, so a union would freeze today's set into the
 * client and a state Fly adds later would be a type error in a repo that cannot
 * see it, or worse, a crash in a `switch`. The UI renders the value it is given
 * and styles the ones it recognises, which degrades to "unknown, shown as text"
 * instead of failing to compile.
 */

/** One machine, as the fleet list reports it. */
export interface FleetMachine {
  /** Fly's machine id. This is what a lifecycle action would address. */
  id: string
  /** The owner, read from `users/{uid}/machines/{id}`. */
  uid: string
  /** arachnefly names sessions `bs-<sessionId>`, so this is often that. */
  name: string
  /** The raw Fly state. Deliberately not a union; see the file header. */
  state: string
  /** The Fly region the machine runs in. */
  region: string
  /** RFC3339 as Fly reports it, so it is a string and not a Date here. */
  createdAt: string
  /** Same encoding as `createdAt`, and absent on a machine never updated. */
  updatedAt: string
}

/**
 * The reply to a fleet list.
 *
 * `truncated` exists so the page can say "there are more" rather than presenting
 * a capped page as the whole fleet. A silent cap is how an operator concludes a
 * machine is gone when it is merely past the limit.
 */
export interface MachineFleetResponse {
  status: 'ok'
  machines: FleetMachine[]
  truncated: boolean
}

/**
 * What a machine is being used for.
 *
 * The two are NOT interchangeable to act on, which is the whole reason the server
 * sends it: a container is driven by the machine routes, while a browser-session
 * machine is released by its session's own close route. Destroying a session's
 * machine directly leaves the session record still billing for a machine that no
 * longer exists.
 */
export type MachineKind = 'container' | 'browser-session'

/**
 * One of the caller's OWN machines.
 *
 * The tenant projection, as opposed to `FleetMachine` above: same collection, but
 * scoped to one uid and carrying `kind`. It has no `config.env` field for the same
 * reason `FleetMachine` does not — a machine document's env holds
 * `WEBRAIN_HTTP_TOKEN`.
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

/** The reply to a "my machines" read. */
export interface MineMachinesResponse {
  status: 'ok'
  machines: MineMachine[]
}
