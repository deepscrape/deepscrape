import { Injectable, inject, PLATFORM_ID } from '@angular/core'
import { isPlatformBrowser } from '@angular/common'
import { HttpClient, HttpHeaders } from '@angular/common/http'
import { Observable, map, throwError } from 'rxjs'
import { API_BASE_URL } from '../variables'
import { AuthService } from './auth.service'
import {
  StorageDeleteRequest,
  StorageDeleteResponse,
  StorageListResponse,
  StoragePresignResponse,
  StorageSaveRequest,
  StorageSaveResponse,
  StorageSettings,
  StorageSettingsRequest,
  StorageSettingsResponse,
} from '../types'

/**
 * The one writer of `/api/storage/*`.
 *
 * Why this is not `StorageService`
 * --------------------------------
 * `core/services/storage.service.ts` already exists and owns the browser
 * `localStorage`/`sessionStorage` injection tokens, which is a different
 * subject entirely (client persistence, not the hosted bucket). Sharing the
 * name would mean one file importing two things called a storage service.
 *
 * Why the credential handling is asymmetric
 * -----------------------------------------
 * `saveSettings` sends `accessKey`/`secretKey` in its body and there is no
 * method that reads either back, because the route has no reply that carries
 * one. `StorageSettings` models that reply as `hasCredentials: boolean`. The
 * two secret parameters are placed on the request object and are never
 * assigned to a field of this class, never logged, and never included in an
 * error message: the value lives on the caller's stack and in the outgoing
 * body, nowhere else. This mirrors `AiKeysService`'s "NEVER RENDER KEY
 * MATERIAL" rule.
 *
 * Same-origin, like every other `/api` service: the credential must not leave
 * our origin, and the production CSP permits only our own.
 */

/**
 * Base64 for a byte array, in chunks.
 *
 * `String.fromCharCode(...bytes)` over a whole file overflows the argument list
 * on anything past ~100 KB, which is every real image. 32 KB chunks keep the
 * spread well inside the limit.
 * @param {Uint8Array} bytes The bytes to encode.
 * @return {string} The base64 text.
 */
const toBase64 = (bytes: Uint8Array): string => {  let binary = ''
  const step = 0x8000

  for (let at = 0; at < bytes.length; at += step) {
    binary += String.fromCharCode(...bytes.subarray(at, at + step))
  }

  return btoa(binary)
}

@Injectable({ providedIn: 'root' })
export class BucketStorageService {
  private readonly http = inject(HttpClient)
  private readonly authService = inject(AuthService)
  private readonly platformId = inject(PLATFORM_ID)
  private readonly base: string = API_BASE_URL + '/storage'

  /** Send one URL to storage. The reply reports the scope the server chose. */
  save(request: StorageSaveRequest): Observable<StorageSaveResponse> {
    const body: StorageSaveRequest = { url: request.url }
    const filename = request.filename?.trim()
    if (filename) {
      body.filename = filename
    }

    return this.http.post<StorageSaveResponse>(this.base + '/save', body, { headers: this.headers() })
  }

  /**
   * Keep bytes the caller already holds -- a job result, a tool reply.
   *
   * `save` above can only file something the platform can fetch again, and a
   * worker artifact is a bare filename on the worker's disk: there is no address
   * to fetch, so a run's result could be read in the UI and then lost. This
   * posts the payload itself. The object lands in the caller's own tier, because
   * the shared tier is keyed by URL and a payload has none.
   *
   * @param {string} content The bytes, as text.
   * @param {string} filename The name to file it under.
   * @param {string} [contentType] The type, when it is not implied by the name.
   * @return {Observable<StorageSaveResponse>} The key the server filed it under.
   */
  savePayload(
    content: string,
    filename: string,
    contentType?: string,
  ): Observable<StorageSaveResponse> {
    const body: Record<string, string> = { content, filename }
    if (contentType) {
      body['contentType'] = contentType
    }

    return this.http.post<StorageSaveResponse>(this.base + '/payload', body, { headers: this.headers() })
  }

  /**
   * Keep bytes that are not text -- an image the user picked.
   *
   * `savePayload` is defined as UTF-8 text and a PNG is not, so a file sent
   * through it would arrive mangled. This base64-encodes instead: the only
   * encoding a JSON body carries unchanged. What the bytes MEAN is the
   * `contentType`'s job, and the route files it under exactly that.
   *
   * The 8 MiB request cap on the BFF is the real ceiling here, not any
   * vendor's, and base64 spends 4/3 of it.
   * @param {Uint8Array} bytes The file's bytes.
   * @param {string} filename The name to file it under.
   * @param {string} contentType The real type, e.g. `image/png`.
   * @return {Observable<StorageSaveResponse>} The key the server filed it under.
   */
  saveBytes(
    bytes: Uint8Array,
    filename: string,
    contentType: string,
  ): Observable<StorageSaveResponse> {
    const body: Record<string, string> = {
      contentBase64: toBase64(bytes),
      filename,
      contentType,
    }

    return this.http.post<StorageSaveResponse>(this.base + '/payload', body, { headers: this.headers() })
  }

  /** Every object this caller may see. */
  list(): Observable<StorageListResponse> {
    return this.http.get<StorageListResponse>(this.base + '/list', { headers: this.headers() })
  }

  /**
   * Mint a short-lived link for one key.
   *
   * A bearer credential in a query string: anyone holding the string can read
   * the object until it expires. Use it only when the URL has to survive outside
   * this tab -- a real download. To VIEW a file, use `objectUrl` below, which
   * hands out nothing.
   */
  presign(key: string): Observable<StoragePresignResponse> {
    return this.http.post<StoragePresignResponse>(this.base + '/presign', { key }, { headers: this.headers() })
  }

  /**
   * The object's bytes as a page-local blob URL.
   *
   * The bytes are fetched with this caller's normal bearer token and wrapped in
   * a `blob:` URL that exists only in this document. Nothing replayable leaves
   * the process, which is the difference between this and `presign`.
   *
   * The caller OWNS the returned URL and must pass it to `revokeObjectUrl` when
   * it is done: a blob URL pins its bytes in memory until it is revoked or the
   * document is destroyed.
   *
   * @param {string} key The object key.
   * @return {Observable<string>} The blob URL.
   */
  objectUrl(key: string): Observable<string> {
    if (!isPlatformBrowser(this.platformId)) {
      return throwError(() => new Error('storage: no browser'))
    }

    return this.http
      .get(this.base + '/object', {
        headers: this.headers(),
        params: { key },
        responseType: 'blob',
      })
      .pipe(map((blob: Blob) => URL.createObjectURL(blob)))
  }

  /**
   * Release a blob URL minted by `objectUrl`.
   *
   * Safe to call twice and safe on a URL this method did not mint: the caller
   * that keeps the URL in a field may revoke it both on close and on destroy.
   * @param {string} url The URL to release.
   */
  revokeObjectUrl(url: string): void {
    if (!isPlatformBrowser(this.platformId)) return
    if (url.startsWith('blob:')) URL.revokeObjectURL(url)
  }

  /**
   * Remove one of the caller's own objects.
   *
   * Idempotent on purpose, and that is what makes it safe to retry: the route
   * answers 200 for a key that is already gone rather than a 404, because the
   * port documents absent-as-success and S3's `DeleteObject` is idempotent by
   * specification. A shared cache object is refused -- it has no owner.
   */
  remove(key: string): Observable<StorageDeleteResponse> {
    const body: StorageDeleteRequest = { key }

    return this.http.post<StorageDeleteResponse>(this.base + '/delete', body, { headers: this.headers() })
  }

  /** The caller's mode and whether a credential is stored. Never the credential. */
  getSettings(): Observable<StorageSettings> {
    return this.http.get<StorageSettings>(this.base + '/settings', { headers: this.headers() })
  }

  /**
   * Set the mode and, for `byob`, optionally rotate the credentials.
   *
   * An omitted secret keeps the stored one, so the browser can change the mode
   * or the bucket name without ever holding a credential it cannot read.
   */
  saveSettings(request: StorageSettingsRequest): Observable<StorageSettingsResponse> {
    const body: StorageSettingsRequest = { mode: request.mode }

    const bucket = request.bucket?.trim()
    if (bucket) {
      body.bucket = bucket
    }

    const endpoint = request.endpoint?.trim()
    if (endpoint) {
      body.endpoint = endpoint
    }

    // Assigned straight onto the outgoing body. Not trimmed into a local, not
    // held on `this`, not echoed anywhere.
    if (request.accessKey) {
      body.accessKey = request.accessKey
    }
    if (request.secretKey) {
      body.secretKey = request.secretKey
    }

    return this.http.post<StorageSettingsResponse>(this.base + '/settings', body, { headers: this.headers() })
  }

  private headers(): HttpHeaders {
    return new HttpHeaders({
      'Authorization': `Bearer ${this.authService.token}`,
      'Accept': 'application/json',
    })
  }
}