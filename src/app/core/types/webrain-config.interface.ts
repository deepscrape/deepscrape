/**
 * The `/api/webrain/config/*` contract.
 *
 * Two rules shape every type below, and both come from the backend rather than
 * from taste:
 *
 * 1. **The token is readable exactly once.** `GET` reports `hasToken` as a
 *    presence bit, never a value and never a length. Only a `POST` that *mints*
 *    a token returns one, in that response alone. So the reply type is a
 *    discriminated union: `token` exists on the `generated: true` arm and is
 *    absent from the other, which is what makes forgetting to narrow a compile
 *    error rather than a blank screen.
 *
 * 2. **A proxy URL is a credential.** It is `scheme://user:pass@host`, it is
 *    write-only, and the read side returns a label plus a masked host with the
 *    credentials stripped. `WebrainProxyEntry` (read) therefore has no `url`
 *    field at all, and `WebrainProxyEntryInput` (write) is a request shape that
 *    no reply type here ever reuses. Nothing in this file can carry a stored
 *    credential back to the client.
 */

/** One proxy exit as the admin surface may read it: label plus masked host. */
export interface WebrainProxyEntry {
  label: string
  /** Bare `host:port`, credentials stripped, or `invalid` when unparseable. */
  host: string
}

/** `GET /api/webrain/config` reply. Presence only, never the token. */
export interface WebrainConfig {
  hasToken: boolean
  proxies: WebrainProxyEntry[]
  /** The pool length the server resolved. Equal to `proxies.length` by construction. */
  poolSize: number
  /** Which seam answered: `secret` for the stored document, `env` for the fallback. */
  source: string
}

/**
 * `POST /api/webrain/config/token` request.
 *
 * WRITE-ONLY, and optional: an absent or blank `token` asks the server to mint
 * one instead. Nothing in the app reads this type back.
 */
export interface WebrainTokenRequest {
  token?: string
}

/**
 * `POST /api/webrain/config/token` reply.
 *
 * The `generated: true` arm is the only place a token value is ever returned,
 * exactly once, on the response to the request that minted it.
 */
export type WebrainTokenResponse =
  | { generated: true; token: string }
  | { generated: false }

/**
 * A proxy exit as the admin supplies it, before validation.
 *
 * WRITE-ONLY. `url` carries the credential; it is sent and never displayed
 * back, so no component may hold an instance of this beyond the request.
 */
export interface WebrainProxyEntryInput {
  label: string
  url: string
}

/** `POST /api/webrain/config/proxies` request. Replaces the pool wholesale. */
export interface WebrainProxiesRequest {
  proxies: WebrainProxyEntryInput[]
}

/** `POST /api/webrain/config/proxies` reply: the pool as stored, masked. */
export interface WebrainProxiesResponse {
  poolSize: number
  proxies: WebrainProxyEntry[]
}

/**
 * One of a CALLER's own exits, as `GET /api/egress` reports it.
 *
 * The counterpart of `WebrainProxyEntry` for the per-caller pool: masked down to
 * `host:port`, so no property here can hold the credential even though the row
 * describes one.
 */
export interface EgressExit {
  /** The masked `host:port`. Safe to display; never the full URL. */
  label: string
  host: string
}

/**
 * Which pool a caller's requests leave from.
 *
 * Not a preference with a default. `platform` is the operator-maintained pool
 * (what every caller used before BYO existed); `byo` is the caller's own. Which
 * one applies is decided server-side by the PRESENCE of a stored pointer, so
 * this reports the server's answer rather than choosing.
 */
export type EgressMode = 'platform' | 'byo'

/** `GET /api/egress` reply. */
export interface EgressSettings {
  mode: EgressMode
  /** A presence bit, never a prefix or a length. */
  hasCredentials: boolean
  /** Masked exits. Empty on the platform default. */
  exits: EgressExit[]
}

/**
 * `PUT /api/egress` request.
 *
 * `mode` is REQUIRED, and the union makes omitting it unrepresentable rather
 * than merely discouraged: read as "set", a typo would clear a working pool, and
 * read as "clear", a typo would quietly drop the caller back onto our exits.
 *
 * There is no field here for the stored URLs, because the server never returns
 * them -- saving REPLACES the pool, so a caller editing one exit re-enters all
 * of them. That is the cost of never echoing a password.
 */
export type EgressWrite =
  | { mode: 'platform' }
  | { mode: 'byo'; proxies: string[] }
