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
