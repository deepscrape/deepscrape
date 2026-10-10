import { Injectable, inject } from '@angular/core'
import { HttpClient, HttpHeaders } from '@angular/common/http'
import { Observable } from 'rxjs'
import { API_BASE_URL } from '../variables'
import { AuthService } from './auth.service'
import {
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
@Injectable({ providedIn: 'root' })
export class BucketStorageService {
  private readonly http = inject(HttpClient)
  private readonly authService = inject(AuthService)
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

  /** Every object this caller may see. */
  list(): Observable<StorageListResponse> {
    return this.http.get<StorageListResponse>(this.base + '/list', { headers: this.headers() })
  }

  /**
   * Mint a short-lived link for one key.
   *
   * The ONLY way the UI opens an object. Constructing a bucket URL here would
   * put the storage layout in the client and break when it changes.
   */
  presign(key: string): Observable<StoragePresignResponse> {
    return this.http.post<StoragePresignResponse>(this.base + '/presign', { key }, { headers: this.headers() })
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