/**
 * The browser-session wire shapes, as the BFF actually answers them.
 *
 * These mirror the SERVER types in `functions/src/domain/browser-session.domain.ts`
 * and `functions/src/handlers/browser-sessions.ts`. They are deliberately the
 * public projection only: the stored record also carries `machineId` and
 * `cdpSecretPath`, and neither has a field here. That is not an omission to fix
 * later, it is the point. `BrowserSessionPublic` exists so a response cannot
 * carry an internal Fly id or a pointer at a credential, and a client type that
 * offered those fields would be inviting someone to ask for them.
 *
 * Keeping `expiresAt` optional matters: a tier with no idle expiry sends none,
 * and `undefined` is a different statement from a timestamp in the past.
 */

/** Which browser engine a session runs. */
export type BrowserSessionKind = 'chrome' | 'lightpanda' | 'obscura'

/**
 * How the session gets its browser.
 *
 * `dedicated` is a machine we lease, and it is the only mode that carries a
 * compute charge. `byo` is the caller's own CDP endpoint, so we provision
 * nothing and bill no browser time.
 */
export type BrowserSessionMode = 'dedicated' | 'byo'

/** Where a session is in its lifecycle. */
export type BrowserSessionState =
  | 'starting'
  | 'ready'
  | 'suspended'
  | 'closed'

/** One session, as a caller may see it. */
export interface BrowserSession {
  id: string
  mode: BrowserSessionMode
  kind: BrowserSessionKind
  state: BrowserSessionState
  /** Epoch ms the session was created. */
  createdAt: number
  /**
   * The idle deadline, when the tier has one. Absent means the tier has no idle
   * expiry, which is not the same as "expires immediately".
   */
  expiresAt?: number
}

/**
 * The body `POST /api/browser/session` accepts.
 *
 * `cdpUrl` is required in practice for `byo` and ignored for `dedicated`. It is
 * a credential: send it, and never hold it beyond the request. The server puts
 * it in Secret Manager and answers with no field that could return it.
 */
export interface BrowserSessionCreateRequest {
  mode: BrowserSessionMode
  kind: BrowserSessionKind
  cdpUrl?: string
}

/** The reply to a create, keepalive or close. */
export interface BrowserSessionResponse {
  status: 'ok'
  session: BrowserSession
}

/** The reply to a list. */
export interface BrowserSessionListResponse {
  status: 'ok'
  sessions: BrowserSession[]
}

/**
 * A refusal.
 *
 * `code` is the machine-readable reason and `error` is a message the server
 * already wrote. Both are typed loosely on purpose: the server's refusal set is
 * the authority, and enumerating it here would create a second list that can
 * drift. The UI reads `code` to choose what to say, and falls back to `error`.
 *
 * The route's own status carries a second axis: 402 is a plan boundary and 403
 * is a permission boundary, and the two must not be collapsed. A viewer who
 * cannot lease anything should not be shown an upgrade button.
 */
export interface BrowserSessionError {
  error: string
  code: string
}

/**
 * One entry in the DURABLE vault, as `op=list` reports it.
 *
 * Names and a timestamp only: the index row holds no credential, and the sealed
 * payload sits in an object the list never names.
 */
export interface VaultDurableEntry {
  service: string
  profile: string
  updatedAtMs?: number
}

/**
 * The reply to `POST /api/browser/vault`.
 *
 * Every field is optional because the four ops answer differently: `list` sends
 * `entries`, `load` sends `entry` and `payload`, and `store` and `forget` send
 * nothing at all. One shape with optionals rather than a union, because the
 * caller already knows which op it asked for.
 *
 * `payload` is `unknown` on purpose. It is the caller's cookie jar travelling
 * through the platform, not a platform model -- the route seals and returns it
 * without ever reading it, so typing it here would invent a contract the
 * platform does not have and cannot verify.
 */
export interface VaultDurableReply {
  entries?: VaultDurableEntry[]
  entry?: { service: string; profile: string }
  payload?: unknown
}
