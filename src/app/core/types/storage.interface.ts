/**
 * The `/api/storage/*` contract.
 *
 * Two words carry the whole design, so they are named once here.
 * --------------------------------------------------------------
 * `scope` says WHO can read a saved object: `shared` means the whole workspace
 * can, `user` means only the saver can. The surfaces that save a file print the
 * value the server returned rather than the value they asked for, because the
 * server is the thing that decides, and a UI that guessed would be able to
 * disagree with the store.
 *
 * `mode` says WHERE files are kept: `platform` is deepscrape's own bucket,
 * `byob` is a bucket the caller brings. In `platform` mode the server needs no
 * credentials from the browser at all, which is why the settings reply carries
 * `hasCredentials` and never a key.
 *
 * No type here can hold a secret
 * ------------------------------
 * `StorageSettings` reports `hasCredentials` as a boolean and `StorageSettingsRequest`
 * is write-only: it is the shape of a request body and has no place in any
 * reply type. There is deliberately no read-back model, mirroring
 * `AiKeysService`'s rule that presence is a boolean rather than a value.
 */

/** Who can read a saved object. */
export type StorageScope = 'shared' | 'user'

/** Where saved objects are kept. */
export type StorageMode = 'platform' | 'byob'

/** `POST /api/storage/save` request. */
export interface StorageSaveRequest {
  url: string
  filename?: string
}

/** `POST /api/storage/save` reply. `cached` means an identical object already existed. */
export interface StorageSaveResponse {
  key: string
  scope: StorageScope
  bytes: number
  cached: boolean
}

/** One stored object, as `GET /api/storage/list` reports it. */
export interface StorageObject {
  key: string
  /** The location the server reported. It is displayed, never used to build a download link. */
  url: string
  scope: StorageScope
  bytes: number
  /** Epoch milliseconds or an ISO string; the server owns the format. */
  createdAt: number | string
}

/** `GET /api/storage/list` reply. Absent means empty, not an error. */
export interface StorageListResponse {
  objects: StorageObject[]
}

/** `POST /api/storage/presign` request. */
export interface StoragePresignRequest {
  key: string
}

/**
 * `POST /api/storage/presign` reply.
 *
 * The only URL the frontend is allowed to open. Building an object URL from the
 * bucket name and key would put the storage layout in the client and break the
 * moment the layout changes, so nothing here ever assembles one.
 */
export interface StoragePresignResponse {
  url: string
}

/** `GET /api/storage/settings` reply. `bucket` is absent in platform mode. */
export interface StorageSettings {
  mode: StorageMode
  hasCredentials: boolean
  bucket?: string
}

/**
 * `POST /api/storage/settings` request.
 *
 * WRITE-ONLY. An omitted field means "keep the stored value", which is what
 * lets the browser submit a mode change without ever holding the credential it
 * already sent. Nothing in the app reads this type back.
 */
export interface StorageSettingsRequest {
  mode: StorageMode
  bucket?: string
  endpoint?: string
  accessKey?: string
  secretKey?: string
}

/** `POST /api/storage/settings` reply. Presence only, never the value. */
export interface StorageSettingsResponse {
  mode: StorageMode
  hasCredentials: boolean
}
