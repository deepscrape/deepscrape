import { Injectable, inject, NgZone, EnvironmentInjector, runInInjectionContext, Injector, PLATFORM_ID } from '@angular/core'
// import { AngularFireDatabase, AngularFireList } from '@angular/fire/compat/database'
import { ActionCodeSettings, Auth, AuthCredential, authState, ConfirmationResult, connectAuthEmulator, getMultiFactorResolver, getRedirectResult, linkWithCredential, linkWithPhoneNumber, linkWithPopup, multiFactor, MultiFactorError, MultiFactorResolver, MultiFactorSession, PhoneAuthProvider, PopupRedirectResolver, reauthenticateWithCredential, RecaptchaVerifier, sendPasswordResetEmail, signInWithEmailAndPassword, signInWithPopup, TotpMultiFactorGenerator, TotpSecret, updatePassword, updateProfile, User, UserCredential } from '@angular/fire/auth'
import {
  addDoc,
  collection, CollectionReference, connectFirestoreEmulator, deleteDoc, doc, docData, DocumentData, DocumentReference,
  FieldValue,
  Firestore, getDoc, getDocs, getFirestore, increment, limit, orderBy, query, Query,
  QueryConstraint, QuerySnapshot, serverTimestamp, setDoc, SetOptions,
  Timestamp, writeBatch, WriteBatch,
  where
} from '@angular/fire/firestore'
import { connectFunctionsEmulator, Functions, httpsCallable } from '@angular/fire/functions'
import { BrowserProfile, CartPack, CrawlConfig, CrawlPack, CrawlResultConfig, Guest, loginHistoryEvent, loginHistoryInfo, loginMetrics, SessionActivityPoint, UserDetails, Users } from '../types'
import { catchError, from, map, Observable, of, switchMap, throwError } from 'rxjs'
import { WindowToken } from './window.service'
import { environment } from 'src/environments/environment'
import {
  connectStorageEmulator, FirebaseStorage, getDownloadURL, getStorage, ref, Storage, StorageReference, uploadString,
  fromTask, uploadBytesResumable, TaskEvent
} from '@angular/fire/storage'
import { createSessionKey } from '../functions'
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Analytics, logEvent, setUserId } from '@angular/fire/analytics'
import { isPlatformBrowser } from '@angular/common'

@Injectable({
  providedIn: 'root'
})
export class FirestoreService {
  private readonly protectedUserFields = new Set<keyof Users>([
    'uid',
    'email',
    'providerId',
    'providerParent',
    'providerData',
    'role',
    'defaultOrgId',
    'plan',
    'stripeId',
    'subscriptionId',
    'status',
    'currentUsage',
    'balance',
    'itemId',
    'mfa_enabled',
    'emailVerified',
    'phoneVerified',
    'phoneNumber',
    'profileStatus'
  ])

  private analytics = inject(Analytics, { optional: true })
  private platformId = inject(PLATFORM_ID)
  private functions = inject(Functions, { optional: true })
  private firestore = inject(Firestore) // inject()

  private storage = inject(Storage)
  private window: Window = inject(WindowToken)
  private readonly _injector: EnvironmentInjector = inject(EnvironmentInjector)
  // item$: Observable<Board[]> | undefined

  constructor(
    private afAuth: Auth,
    private ngZone: NgZone, // Inject NgZone
    private http: HttpClient
  ) {
    // this.app = initializeApp(environment.firebaseConfig)
    this.firestore = this.getInstanceDB('easyscrape')

    this.storage = this.getStorage()

    if (this.isBrowserRuntime() && this.isLocalhost() && environment.emulators) {

      console.log('🔥 Connecting Firestore Service to Firebase Emulators')

      // Connect to the Firestore emulator if running on localhost and not in production
      connectFirestoreEmulator(this.firestore, 'localhost', 5001)
      connectAuthEmulator(this.afAuth, 'http://localhost:9099')
      connectStorageEmulator(this.storage, 'localhost', 9199) // <-- Add this line
      if (this.functions) {
        connectFunctionsEmulator(this.functions, 'localhost', 8081)
      }

    }
  }

  private isBrowserRuntime(): boolean {
    return isPlatformBrowser(this.platformId)
  }

  getInstanceDB(databaseName?: string): Firestore {
    // Get Firestore with the specified database name
    return getFirestore(this.afAuth.app, this.getFirestoreInstance(databaseName))
  }

  getStorage(bucketURL?: string): FirebaseStorage {
    return getStorage(this.afAuth.app, bucketURL)
  }



  isLocalhost(): boolean {
    return typeof this.window !== 'undefined' &&
      (this.window.location.hostname === 'localhost' ||
        this.window.location.hostname === '127.0.0.1')
  }

  private getFirestoreInstance(databaseName?: string): string {
    switch (databaseName) {
      case undefined:
      case '':
      case 'default':
        return '(default)'
      case 'auth0':
        return databaseName
      case 'supply':
        return databaseName
      case 'order':
        return databaseName
      case 'easyscrape':
        return databaseName
      default:
        throw new Error('Invalid database name')
    }
  }

  private toCountMapFromSummary(summary: any, rawKey: string, topKey: string, itemKey: string, topN?: number): { [key: string]: number } | null {
    const rawCounts = summary?.[rawKey]
    if (rawCounts && typeof rawCounts === 'object' && !Array.isArray(rawCounts)) {
      const entries = Object.entries(rawCounts as Record<string, number>)
        .filter(([key]) => !!key)
        .sort(([, left], [, right]) => Number(right) - Number(left))

      return Object.fromEntries(typeof topN === 'number' ? entries.slice(0, topN) : entries)
    }

    const topItems = summary?.[topKey]
    if (Array.isArray(topItems)) {
      const items = topItems
        .map((item: Record<string, unknown>) => {
          const name = String(item?.[itemKey] || '')
          const count = Number(item?.['count'] || 0)
          return [name, count] as const
        })
        .filter(([name, count]) => !!name && Number.isFinite(count))

      if (items.length > 0) {
        return Object.fromEntries(typeof topN === 'number' ? items.slice(0, topN) : items)
      }
    }

    return null
  }

  private async getGuestAnalyticsSummary(): Promise<any | null> {
    try {
      return await this.getDashboardSummary()
    } catch (error) {
      console.warn('Guest analytics summary unavailable, falling back to guests collection:', error)
      return null
    }
  }

  /** Bounds for the guests fallback scan — see scanGuestsCollection. */
  private static readonly GUESTS_SCAN_LIMIT = 10000
  private static readonly GUESTS_SCAN_TTL_MS = 30_000
  /** In-memory cache for the guests fallback scan. */
  private _guestsScanCache: { at: number; value: QuerySnapshot<DocumentData> | null } | null = null

  /**
   * Fallback path behind every `getGuestsBy*` breakdown: the pre-aggregated summary
   * doc was unavailable, so each caller scans the `guests` collection itself. Nine
   * callers route through here and a dashboard renders several of them at once, so
   * without this cache ONE page load re-read the whole collection once per panel.
   */
  private async scanGuestsCollection(): Promise<QuerySnapshot<DocumentData> | null> {
    const cached = this._guestsScanCache
    if (cached && Date.now() - cached.at < FirestoreService.GUESTS_SCAN_TTL_MS) {
      return cached.value
    }

    try {
      const guestsCollection = this.collection(this.firestore, 'guests')
      // Bounded: an unbounded scan on a degraded path turns one missing summary doc
      // into a full-collection download.
      const guestsQuery = this.query(
        guestsCollection,
        this.limit(FirestoreService.GUESTS_SCAN_LIMIT),
      )
      const value = await this.getDocs(guestsQuery)

      if (value.size >= FirestoreService.GUESTS_SCAN_LIMIT) {
        console.warn(
          `Guests fallback scan hit its ${FirestoreService.GUESTS_SCAN_LIMIT} doc limit — totals are capped.`,
        )
      }

      this._guestsScanCache = { at: Date.now(), value }
      return value
    } catch (error) {
      console.error('Failed to read guests collection:', error)
      return null
    }
  }


  /**
   * This TypeScript function asynchronously retrieves user data based on a provided user ID.
   * @param {string} userId - The `userId` parameter is a string that represents the unique identifier
   * of the user whose data you want to retrieve.
   * @returns The `getUserData` function returns a Promise that resolves to either a `Users` object if
   * the user data exists in the database, or `null` if the user data does not exist or if there was an
   * error retrieving the data.
   */
  async getUserData(userId: string): Promise<Users | null> {
    try {
      const userRef = this.doc('users', userId)
      const docSnapshot = await this.getDoc(userRef)

      if (docSnapshot['exists']()) {
        const data = docSnapshot['data']() as any

        return {
          ...data,
          last_login_at: data.last_login_at ? (data.last_login_at as any).toDate() : null,
          created_At: data.created_At ? (data.created_At as any).toDate() : null,
          updated_At: data.updated_At ? (data.updated_At as any).toDate() : null
        } as Users
      }

      return null
    } catch (err) {
      // ponytail: a permission-denied read while nobody is signed in is the expected
      // outcome of an app boot or a revoked session, not a failure. Logging it buried
      // real errors and sent every signed-out user hunting for a rules bug.
      const denied = (err as {code?: string})?.code === 'permission-denied'
      if (!denied || this.afAuth.currentUser) {
        console.error("Failed to get user's data:", err)
      }
      return null
    }
  }

  async setUserData(userId: string, data: Partial<Users>, merge: boolean = true): Promise<boolean | Error> {

    try {
      const userRef = this.doc('users', userId)
      const sanitizedData = this.sanitizeUserWrite(data)

      if (Object.keys(sanitizedData).length === 0) {
        return true
      }

      await this.setDoc(userRef, sanitizedData, { merge })
      console.log('User data stored successfully.')
      return true
    } catch (error) {
      console.error('Error storing user data:', error)
      throw error as any
    }
  }

  /**
   * Updates email verification status in Firestore
   * Should be called after Firebase Auth email is verified via applyActionCode()
   * This ensures Firestore stays in sync with Firebase Auth
   * 
   * @param uid - User's UID
   * @param emailVerified - Email verification status
   */
  async updateEmailVerificationStatus(uid: string, emailVerified: boolean): Promise<void> {
    try {
      const userRef = this.doc('users', uid);
      await this.setDoc(userRef, {
        emailVerified,
        updated_At: serverTimestamp(),
      }, { merge: true });
      
      console.log(`Email verification status updated for user ${uid}: ${emailVerified}`);
    } catch (error) {
      console.error('Error updating email verification status:', error);
      throw error;
    }
  }

  async updatePhoneVerificationStatus(uid: string, phoneVerified: boolean): Promise<void> {
    try {
      const userRef = this.doc('users', uid);
      await this.setDoc(userRef, {
        phoneVerified,
        updated_At: serverTimestamp(),
      }, { merge: true });
      
      console.log(`Phone verification status updated for user ${uid}: ${phoneVerified}`);
    } catch (error) {
      console.error('Error updating phone verification status:', error);
      throw error;
    }
  }

  async updateUserPhoneNumber(uid: string, phoneNumber: string, phoneVerified: boolean = false): Promise<void> {
    try {
      const userRef = this.doc('users', uid);
      await this.setDoc(userRef, {
        phoneNumber,
        phoneVerified,
        updated_At: serverTimestamp(),
      }, { merge: true });
      
      console.log(`Phone number updated for user ${uid}: ${phoneNumber}`);
    } catch (error) {
      console.error('Error updating phone number:', error);
      throw error;
    }
  }

  /**
   * Refreshes user data from Firestore
   * Used after profile changes (like email verification) to get fresh data
   * 
   * @param uid - User's UID
   * @returns Fresh user data from Firestore or null if not found
   */
  async refreshUserFromFirestore(uid: string): Promise<Users | null> {
    try {
      const userData = await this.getUserData(uid);
      if (!userData) {
        throw new Error(`User data not found for UID: ${uid}`);
      }
      console.log(`User data refreshed from Firestore for ${uid}`);
      return userData;
    } catch (error) {
      console.error('Error refreshing user data from Firestore:', error);
      throw error;
    }
  }

  async storeUserData(user: User, providerId: string, emailVerified: boolean = false,
    newUsername?: string | null, phoneVerified: boolean | null = null): Promise<boolean | Error> {
    try {
      const userRef = this.doc('users', user.uid)
      const currUserProvider = user.providerData.find(p => p.providerId === providerId)
      const username = newUsername || currUserProvider?.email?.split('@')[0] || ''

      const dbuser: Partial<Users> = {
        username,
        last_login_at: new Date(user.metadata.lastSignInTime || ''),
        created_At: new Date(user.metadata.creationTime || ''),
        updated_At: new Date(),
      }

      const sanitizedUserData = this.sanitizeUserWrite(dbuser)

      if (Object.keys(sanitizedUserData).length === 0) {
        return true
      }

      await this.setDoc(userRef, sanitizedUserData, { merge: true })

      console.log('User data stored successfully.')
      return true
    } catch (error) {
      console.error('Error storing user data:', error)
      return error as any
    }
  }

  async setUserLoginMetrics(userId: string, metrics: loginHistoryInfo, guestInfo?: Guest, sessionIdOverride?: string) {
    // Legacy compatibility projection only; enterprise session authority is Cloud Functions.
    return this.upsertLegacyLoginMetricsProjection(userId, metrics, guestInfo, sessionIdOverride)
  }

  private async upsertLegacyLoginMetricsProjection(
    userId: string,
    metrics: loginHistoryInfo,
    guestInfo?: Guest,
    sessionIdOverride?: string,
  ) {
    const {
      ipAddress,
      userAgent,
      location,
      deviceType,
      connection,
      providerId,
      browser,
      deviceFingerprintHash,
    } = metrics

    const normalizedUserId = String(userId || '').trim()
    const normalizedIpAddress = String(ipAddress || '').trim()
    const normalizedUserAgent = String(userAgent || '').trim()
    const normalizedProviderId = String(providerId || '').trim() || 'unknown'

    if (!normalizedUserId || !normalizedIpAddress || !normalizedUserAgent) {
      throw new Error('UID, IP Address, and User Agent are required.')
    }

    try {
      const batch = this.writeBatch()
      const loginMetricsRef = this.doc('login_metrics', normalizedUserId)
      const loginMetricsSnap = await this.getDoc(loginMetricsRef)
      const currentTime = serverTimestamp()

      if (!loginMetricsSnap['exists']()) {
        batch.set(loginMetricsRef, {
          guestId: guestInfo?.id || '',
          id: normalizedUserId,
          creationTime: currentTime,
          lastSignInTime: currentTime,
          loginCount: 0,
        }, { merge: false })
      }

      if (!guestInfo) {
        console.log('Guest info not provided. Continuing metrics without guest enrichment.')
      }

      const ip = guestInfo?.ip?.raw || normalizedIpAddress
      const currentLocation = guestInfo?.location || location || 'Unknown'
      const currentBrowser = browser || guestInfo?.browser || 'Unknown'
      const currentOS = guestInfo?.os || 'Unknown'
      const currDeviceType = deviceType || guestInfo?.device || 'Unknown'
      const currUserAgent = normalizedUserAgent || guestInfo?.userAgent || 'Unknown'
      const sessionKey = createSessionKey(ip, currDeviceType, normalizedProviderId, currentBrowser, currentOS, currentLocation)
      const canonicalSessionId = String(sessionIdOverride || sessionKey).trim() || sessionKey

      const loginHistoryEntry: loginHistoryInfo = {
        uid: normalizedUserId,
        providerId: normalizedProviderId,
        connection,
        connected: true,
        timestamp: new Date(),
        ipAddress: ip,
        os: currentOS,
        browser: currentBrowser,
        userAgent: currUserAgent,
        location: currentLocation,
        deviceType: currDeviceType,
        sessionKey,
        ...(guestInfo ? { guestId: guestInfo.id } : {}),
        deviceFingerprintHash,
      }

      const loginHistoryRef = this.doc(`login_metrics/${normalizedUserId}/login_history_Info`, canonicalSessionId)
      batch.set(loginHistoryRef, loginHistoryEntry, { merge: true })

      const loginEventRef = this.doc(`login_metrics/${normalizedUserId}/login_history_events`, `login-${canonicalSessionId}`)
      batch.set(loginEventRef, {
        ...loginHistoryEntry,
        eventType: 'login',
        eventSessionId: canonicalSessionId,
        createdAt: currentTime,
      }, { merge: true })

      const newLoginMetrics = {
        lastGuestId: guestInfo?.id || '',
        id: normalizedUserId,
        lastLoginId: canonicalSessionId,
        lastSignInTime: currentTime,
        loginCount: this.increment(1),
      }

      batch.set(loginMetricsRef, newLoginMetrics, { merge: true })
      await batch.commit()

      return {
        success: true,
        message: `Login metrics recorded for user ${normalizedUserId}.`,
        loginId: canonicalSessionId,
      }
    }
    catch (error) {
      console.error('Error storing user data:', error)
      return null
    }
  }

  async setSignOutMetrics(userId: string, loginId: string) {

    if (!userId) {
      throw new Error('User ID is required for sign-out metrics.')
    }

    // If loginId is missing, log warning but don't fail - user logout should still proceed
    if (!loginId) {
      console.warn('Login ID not available for sign-out metrics - will skip recording sign-out time')
      return { success: true, message: `Sign-out recorded for user ${userId} (no login session found).` }
    }

    try {
      return await this.callFunction<
        { loginId: string },
        { success: boolean; loginId: string; signedOutAt: string }
      >('signOutLoginSession', { loginId })
    }
    catch (error) {
      console.error('Error storing sign-out data:', error)
      return null
    }
  }

  getMyLoginSessions(limitCount: number = 20): Observable<loginHistoryInfo[]> {
    const limit = Math.max(1, Math.min(50, Math.floor(limitCount || 20)))

    return from(
      this.callFunction<{ limit: number }, { sessions?: loginHistoryInfo[] }>('getMyLoginSessions', { limit })
    ).pipe(
      map((res) => Array.isArray(res?.sessions) ? res.sessions : [])
    )
  }

  getMyLoginSessionsWithFallback(limitCount: number = 20): Observable<loginHistoryInfo[]> {
    const limit = Math.max(1, Math.min(50, Math.floor(limitCount || 20)))

    return this.getMyLoginSessions(limit).pipe(
      catchError(() => of([])),
      switchMap((sessions) => {
        const newSessions = Array.isArray(sessions) ? sessions : []

        return of(this.afAuth.currentUser).pipe(
          switchMap((user) => {
            if (!user?.uid) {
              return of(newSessions.slice(0, limit))
            }

            // Merge enterprise + legacy login session sources for backwards compatibility.
            return from(this.getLoginHistoryNew(user.uid, undefined, undefined, limit)).pipe(
              map((legacySessions) => {
                const merged = new Map<string, loginHistoryInfo>()

                const resolveSessionKey = (session: loginHistoryInfo): string =>
                  String(session?.sessionKey || session?.id || '')

                for (const session of newSessions) {
                  const key = resolveSessionKey(session)
                  if (key) {
                    merged.set(key, session)
                  }
                }

                for (const session of (legacySessions || []) as loginHistoryInfo[]) {
                  const key = resolveSessionKey(session)
                  if (key && !merged.has(key)) {
                    merged.set(key, session)
                  }
                }

                const parseTime = (value: unknown): number => {
                  if (!value) return 0
                  if (value instanceof Date) return value.getTime()
                  const timestamp = value as { toDate?: () => Date; seconds?: number }
                  if (typeof timestamp?.toDate === 'function') {
                    return timestamp.toDate().getTime()
                  }
                  if (typeof timestamp?.seconds === 'number') {
                    return timestamp.seconds * 1000
                  }
                  const parsed = new Date(value as string | number)
                  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime()
                }

                return Array.from(merged.values())
                  .sort((a, b) => {
                    const left = parseTime((a as any).timestamp || (a as any).createdAt || (a as any).lastSignInTime)
                    const right = parseTime((b as any).timestamp || (b as any).createdAt || (b as any).lastSignInTime)
                    return right - left
                  })
                  .slice(0, limit)
              }),
              catchError(() => of(newSessions.slice(0, limit))),
            )
          }),
          catchError(() => of(newSessions.slice(0, limit))),
        )
      }),
    )
  }

  getMyLoginHistoryEvents(limitCount: number = 20): Observable<loginHistoryEvent[]> {
    const limitValue = Math.max(1, Math.min(50, Math.floor(limitCount || 20)))

    return of(this.afAuth.currentUser).pipe(
      switchMap((user) => {
        if (!user?.uid) {
          return of([])
        }

        return from(this.getLoginHistoryEventsNew(user.uid, limitValue)).pipe(
          catchError(() => of([])),
        )
      }),
      catchError(() => of([])),
    )
  }

  revokeMyLoginSession(loginId: string): Observable<{ success: boolean; loginId: string; revokedAt: string }> {
    return from(
      this.callFunction<{ loginId: string }, { success: boolean; loginId: string; revokedAt: string }>('revokeMyLoginSession', { loginId })
    )
  }

  getMyLoginSessionStatus(loginId: string): Observable<{ loginId: string; active: boolean; revoked: boolean; revokedAt?: string | null }> {
    return from(
      this.callFunction<{ loginId: string }, { loginId: string; active: boolean; revoked: boolean; revokedAt?: string | null }>('getMyLoginSessionStatus', { loginId })
    )
  }

  getUserLoginSessionsByAdmin(targetUserId: string, limit: number = 50, activeOnly: boolean = false): Observable<{
    success: boolean;
    targetUserId: string;
    sessions: loginHistoryInfo[];
    total: number;
  }> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit || 50)))

    return from(
      this.callFunction<
        { targetUserId: string; limit: number; activeOnly: boolean },
        { success: boolean; targetUserId: string; sessions: loginHistoryInfo[]; total: number }
      >('getUserLoginSessionsByAdmin', {
        targetUserId,
        limit: safeLimit,
        activeOnly,
      })
    )
  }

  revokeUserLoginSessionByAdmin(loginId: string, reason?: string): Observable<{
    success: boolean;
    loginId: string;
    targetUserId: string;
    revokedAt: string;
  }> {
    return from(
      this.callFunction<
        { loginId: string; reason?: string },
        { success: boolean; loginId: string; targetUserId: string; revokedAt: string }
      >('revokeUserLoginSessionByAdmin', { loginId, reason })
    )
  }

  /** In-memory cache keyed by sessionId → sorted activity points. */
  private readonly _sessionActivityCache = new Map<string, SessionActivityPoint[]>()

  /**
   * Fetch activity data for a specific login session from the Firestore subcollection
   * `loginSessions/{sessionId}/activity`, ordered ascending by timestamp, limited to 100 docs.
   * Results are cached in memory for the lifetime of the service instance.
   */
  async getLoginSessionActivity(sessionId: string): Promise<SessionActivityPoint[]> {
    if (this._sessionActivityCache.has(sessionId)) {
      return this._sessionActivityCache.get(sessionId)!
    }

    const result = await this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<SessionActivityPoint[]> => {
        const colRef = collection(this.firestore, 'loginSessions', sessionId, 'activity')
        const q = query(colRef, orderBy('timestamp', 'asc'), limit(100))
        const snap = await getDocs(q)
        return snap.docs.map((d) => {
          const raw = d.data()
          const ts = raw['timestamp']
          return {
            timestamp: ts && typeof ts.toDate === 'function' ? (ts as { toDate(): Date }).toDate() : new Date(ts),
            activeSeconds: typeof raw['activeSeconds'] === 'number' ? raw['activeSeconds'] : 0,
            activityCount: typeof raw['activityCount'] === 'number' ? raw['activityCount'] : 0,
          } satisfies SessionActivityPoint
        })
      },
    )

    this._sessionActivityCache.set(sessionId, result)
    return result
  }

  /** Remove a cached session activity entry (e.g. after a page refresh). */
  clearLoginSessionActivityCache(sessionId?: string): void {
    if (sessionId) {
      this._sessionActivityCache.delete(sessionId)
    } else {
      this._sessionActivityCache.clear()
    }
  }

  revokeAllUserSessionsByAdmin(targetUserId: string, reason?: string, limit: number = 100): Observable<{
    success: boolean;
    targetUserId: string;
    revokedCount: number;
    sessionIds: string[];
  }> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit || 100)))

    return from(
      this.callFunction<
        { targetUserId: string; reason?: string; limit: number },
        { success: boolean; targetUserId: string; revokedCount: number; sessionIds: string[] }
      >('revokeAllUserSessionsByAdmin', {
        targetUserId,
        reason,
        limit: safeLimit,
      })
    )
  }

  async linkGuestToUser(uid: string, guestId: string) {
    if (!uid || !guestId) {
      throw new Error("User ID and Guest ID are required.");
    }

    try {
      const response = await this.callFunction<
        { uid: string; guestId: string },
        { ok: boolean; linkedUid: string; guestId: string; guestInfo?: Guest | null }
      >('linkGuestToUser', { uid, guestId });

      const guestInfo = response?.guestInfo ?? null;
      console.log(`Guest ${guestId} linked to user ${uid} via backend function.`);
      return { err: null, guestInfo };
    } catch (error) {
      console.error("Error linking guest data to user:", error);
      return { err: error as string, guestInfo: null };
    }
  }



  /* get last 10 crawl pack config items by sorted date from the store  */
  // async getPack

  /* store the cart data when goes the app goes online */
  async savePackToFirestore(userId: string, item: any, merge: boolean = true) {
    try {
      const cartRef = this.doc(`users/${userId}/cartpack`, userId)
      await this.setDoc(cartRef, item, { merge })
      console.log('Pack data stored successfully in Firestore.')

    } catch (error) {
      console.error('Error storing user data:', error)
    }
  }

  /* store the cart data when goes the app goes online */
  async saveCrawlPackToFirestore(userId: string, item: CrawlPack, merge: boolean = true) {
    try {
      if (!userId)
        throw new Error('User ID is required')

      const cartRef = this.collection(this.firestore, `users/${userId}/crawlpack`)

      await this.addDoc(cartRef, item)
      console.log('Crawler Pack data stored successfully in Firestore.')
      return true
    } catch (error) {
      return error as any
    }
  }

  async deletePackFromFirestore(userId: string) {

    try {

      // Create a reference to the "operations" subcollection of the user document
      const cartRef = this.doc(`users/${userId}/cartpack`, userId)

      await this.deleteDoc(cartRef)
      console.log("Document deleted successfully")

    } catch (error) {
      console.error('Error removing user data:', error)
    }
  }

  async loadPreviousPacks(userId: string, limit = 10): Promise<CrawlPack[] | null> {
    const packsCollection = this.collection(this.firestore, `users/${userId}/crawlpack`)
    const q = this.query(packsCollection, this.limit(limit)) // Adjust limit as needed
    let err, querySnapshot = await this.getDocs(q)
    if (err) {
      console.error("Failed to get user's data:", err)
      return null
    }

    if (!querySnapshot.empty)
      return querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }) as CrawlPack)

    return [] // Return an empty array if no documents found
  }

  async uploadFileToStorage(base64: string, userId: string, fileName: string, metadata?: { [key: string]: any }): Promise<string> {


    try {
      const storageRef = await this.ref(this.storage, `uploads/${userId}/${fileName}`) // Define the file path in storage

      // Upload the Base64 string as a file
      await this.uploadString(storageRef, base64, 'base64', { customMetadata: metadata })

      // Creating an upload task 
      // const byteArray = new Uint8Array(Buffer.from(base64, 'base64'))
      // const uploadTask = uploadBytesResumable(storageRef, byteArray, { customMetadata: metadata })

      // console.log('Photo Profile uploaded successfully!')

      // // Just listening for progress/state changes, this is legal.
      // uploadTask.on("state_changed", (snapshot) => {
      //   var percent = snapshot.bytesTransferred / snapshot.totalBytes * 100
      //   console.log(percent + "% done")
      // })

      // // This is also legal.
      //   uploadTask.on("state_changed", {
      //     'complete': () => {
      //       console.log('upload complete!')
      //     }
      //   })
      // Get the download URL
      const downloadURL = await this.getDownloadURL(storageRef)
      console.log('Download URL:', downloadURL)
      return downloadURL
    } catch (error) {
      console.error('Error uploading file:', error)
      throw error
    }
  }

  async saveFileUrlToFirestore(userId: string, fileUrl: string): Promise<void> {
    const userDocRef = this.doc('users', userId) // Reference to the user's document

    try {
      await this.setDoc(userDocRef, { details: { photoURL: fileUrl } }, { merge: true })
      console.log('File URL saved to Firestore!')
    } catch (error) {
      console.error('Error saving file URL to Firestore:', error)
      throw error
    }
  }

  /* Crawler Packs - Browser Profiles - Crawler Configurations - Crawler Results - Crawler Strategies 
  *  Each of these should be their own collections and subcollections
  *  under the user document.
  */

  async storeBrowserProfile(userId: string, profile: BrowserProfile): Promise<void> {
    return this.storeUserConfig(userId, profile, 'browser', 'Browser profile')
  }

  async storeCrawlConfig(userId: string, config: CrawlConfig): Promise<void> {
    return this.storeUserConfig(userId, config, 'crawlconfigs', 'Crawl Config')
  }

  async storeCrawlResultsConfig(userId: string, config: CrawlResultConfig): Promise<void> {
    return this.storeUserConfig(userId, config, 'crawlresultsconfig', 'CrawlResult Config')
  }


  /**
 * Generic method to store user-related configurations in Firestore
 * @param userId The user ID
 * @param data The data object to store
 * @param collectionPath The subcollection path where data should be stored
 * @param itemName Human-readable name for logging
 * @returns Promise that resolves when the operation completes
 */
  async storeUserConfig<T extends { id?: string; uid?: string }>(
    userId: string,
    data: T,
    collectionPath: string,
    itemName: string
  ): Promise<void> {
    try {
      const configCollection = this.collection(this.firestore, `users/${userId}/${collectionPath}`);
      data.uid = userId

      const configRef = data.id
        ? this.docRef(configCollection, data.id) // Update existing item
        : this.newDocRef(configCollection) // Create new item

      // Exclude 'id' property when storing the data
      const { id, ...dataWithoutId } = data as any
      await this.setDoc(configRef, dataWithoutId, { merge: !!data.id })
      console.log(`${data.id ? `${itemName} updated` : `New ${itemName} created`} in Firestore.`)
    } catch (error) {
      console.error(`Error storing user ${itemName.toLowerCase()} data:`, error)
      throw error
    }
  }


   // ============================================================================
  // GUEST ANALYTICS METHODS
  // ============================================================================

  /**
   * Get guest analytics by country (Top N countries)
   * INDEX REQUIRED: Collection: guests, Fields: country (Ascending)
   */
  async getGuestsByCountry(topN: number = 10): Promise<{ [country: string]: number }> {
    const summary = await this.getGuestAnalyticsSummary()
    const optimized = this.toCountMapFromSummary(summary, 'byCountry', 'topCountries', 'country', topN)
    if (optimized) {
      return optimized
    }

    const querySnapshot = await this.scanGuestsCollection()
    if (!querySnapshot) {
      return {}
    }

    const countryMap: { [country: string]: number } = {};
    querySnapshot.docs.forEach(doc => {
      const data = doc.data();
      const country = data['country'] || 'Unknown';
      countryMap[country] = (countryMap[country] || 0) + 1;
    });

    // Sort and get top N
    const sorted = Object.entries(countryMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, topN);
    
    return Object.fromEntries(sorted);
  }

  /**
   * Get guest analytics by browser
   * INDEX REQUIRED: Collection: guests, Fields: browser (Ascending)
   */
  async getGuestsByBrowser(): Promise<{ [browser: string]: number }> {
    const summary = await this.getGuestAnalyticsSummary()
    const optimized = this.toCountMapFromSummary(summary, 'byBrowser', 'topBrowsers', 'browser')
    if (optimized) {
      return optimized
    }

    const querySnapshot = await this.scanGuestsCollection()
    if (!querySnapshot) {
      return {}
    }

    const browserMap: { [browser: string]: number } = {};
    querySnapshot.docs.forEach(doc => {
      const data = doc.data();
      const browser = data['browser'] || 'Unknown';
      browserMap[browser] = (browserMap[browser] || 0) + 1;
    });

    return browserMap;
  }

  /**
   * Get guest analytics by device type
   * INDEX REQUIRED: Collection: guests, Fields: device (Ascending)
   */
  async getGuestsByDevice(): Promise<{ [device: string]: number }> {
    const summary = await this.getGuestAnalyticsSummary()
    const optimized = this.toCountMapFromSummary(summary, 'byDevice', 'topDevices', 'device')
    if (optimized) {
      return optimized
    }

    const querySnapshot = await this.scanGuestsCollection()
    if (!querySnapshot) {
      return {}
    }

    const deviceMap: { [device: string]: number } = {};
    querySnapshot.docs.forEach(doc => {
      const data = doc.data();
      const device = data['device'] || 'Unknown';
      deviceMap[device] = (deviceMap[device] || 0) + 1;
    });

    return deviceMap;
  }

  /**
   * Get guest analytics by OS
   * INDEX REQUIRED: Collection: guests, Fields: os (Ascending)
   */
  async getGuestsByOS(): Promise<{ [os: string]: number }> {
    const summary = await this.getGuestAnalyticsSummary()
    const optimized = this.toCountMapFromSummary(summary, 'byOS', 'topOperatingSystems', 'os')
    if (optimized) {
      return optimized
    }

    const querySnapshot = await this.scanGuestsCollection()
    if (!querySnapshot) {
      return {}
    }

    const osMap: { [os: string]: number } = {};
    querySnapshot.docs.forEach(doc => {
      const data = doc.data();
      const os = data['os'] || 'Unknown';
      osMap[os] = (osMap[os] || 0) + 1;
    });

    return osMap;
  }

  /**
   * Get conversion metrics: Guests who registered vs unregistered
   * COMPOSITE INDEX REQUIRED: Collection: guests, Fields: linkedAt (Ascending), uid (Ascending)
   * 
   * Guests with uid field populated have registered/logged in
   */
  async getGuestConversionMetrics(): Promise<{
    registered: number;
    unregistered: number;
    conversionRate: number;
  }> {
    const summary = await this.getGuestAnalyticsSummary()
    if (summary && typeof summary.totalGuests === 'number' && typeof summary.guestConversions === 'number') {
      const registered = Number(summary.guestConversions || 0)
      const totalGuests = Number(summary.totalGuests || 0)
      const unregistered = Math.max(0, totalGuests - registered)
      const conversionRate = Number(summary.conversionRate || (totalGuests > 0 ? (registered / totalGuests) * 100 : 0))

      return {
        registered,
        unregistered,
        conversionRate: Math.round(conversionRate * 100) / 100,
      }
    }

    const querySnapshot = await this.scanGuestsCollection()
    if (!querySnapshot) {
      return { registered: 0, unregistered: 0, conversionRate: 0 };
    }

    let registered = 0;
    let unregistered = 0;

    querySnapshot.docs.forEach(doc => {
      const data = doc.data();
      // Check if guest has been linked to a user (has uid or linkedAt)
      if (data['uid'] || data['linkedAt']) {
        registered++;
      } else {
        unregistered++;
      }
    });

    const total = registered + unregistered;
    const conversionRate = total > 0 ? (registered / total) * 100 : 0;

    return {
      registered,
      unregistered,
      conversionRate: Math.round(conversionRate * 100) / 100
    };
  }

  /**
   * Get guest activity over time (by creation date)
   * INDEX REQUIRED: Collection: guests, Fields: createdAt (Ascending)
   */
  async getGuestActivityByDay(limitDays: number = 7): Promise<{ [date: string]: number }> {
    try {
      const metricsCollection = this.collection(this.firestore, 'metrics_daily')
      const metricsQuery = this.query(metricsCollection, this.orderBy('date', 'asc'))
      const metricsSnapshot = await this.getDocs(metricsQuery)
      if (!metricsSnapshot.empty) {
        const ordered = metricsSnapshot.docs
          .map(doc => doc.data())
          .filter(data => !!data['date'])
          .slice(-limitDays)

        const optimized = ordered.reduce((accumulator, data) => {
          const dateKey = String(data['date'])
          accumulator[dateKey] = Number(data['newGuests'] || data['totalGuests'] || 0)
          return accumulator
        }, {} as { [date: string]: number })

        if (Object.keys(optimized).length > 0) {
          return optimized
        }
      }
    } catch (error) {
      console.warn('Daily metrics unavailable, falling back to guests collection:', error)
    }

    const querySnapshot = await this.scanGuestsCollection()
    if (!querySnapshot) {
      return {};
    }

    const result: { [date: string]: number } = {};

    querySnapshot.docs.forEach(doc => {
      const data = doc.data();
      const createdAt = data['createdAt'];
      if (createdAt) {
        // Handle Firestore Timestamp
        const date = createdAt.toDate ? createdAt.toDate() : new Date(createdAt);
        const dateKey = date.toISOString().split('T')[0];
        result[dateKey] = (result[dateKey] || 0) + 1;
      }
    });

    // Limit to last N days
    const sortedDates = Object.keys(result).sort().slice(-limitDays);
    const limitedResult: { [date: string]: number } = {};
    for (const date of sortedDates) {
      limitedResult[date] = result[date];
    }

    return limitedResult;
  }

  /**
   * Get guest analytics by timezone (Top N timezones)
   * INDEX REQUIRED: Collection: guests, Fields: timezone (Ascending)
   */
  async getGuestsByTimezone(topN: number = 10): Promise<{ [timezone: string]: number }> {
    const summary = await this.getGuestAnalyticsSummary()
    const optimized = this.toCountMapFromSummary(summary, 'byTimezone', 'topTimezones', 'timezone', topN)
    if (optimized) {
      return optimized
    }

    const querySnapshot = await this.scanGuestsCollection()
    if (!querySnapshot) {
      return {}
    }

    const timezoneMap: { [timezone: string]: number } = {};
    querySnapshot.docs.forEach(doc => {
      const data = doc.data();
      const timezone = data['timezone'] || 'Unknown';
      timezoneMap[timezone] = (timezoneMap[timezone] || 0) + 1;
    });

    // Sort and get top N
    const sorted = Object.entries(timezoneMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, topN);
    
    return Object.fromEntries(sorted);
  }

  /**
   * Get guest analytics by language
   * INDEX REQUIRED: Collection: guests, Fields: language (Ascending)
   */
  async getGuestsByLanguage(): Promise<{ [language: string]: number }> {
    const querySnapshot = await this.scanGuestsCollection()
    if (!querySnapshot) {
      return {}
    }

    const languageMap: { [language: string]: number } = {};
    querySnapshot.docs.forEach(doc => {
      const data = doc.data();
      const language = data['language'] || 'Unknown';
      languageMap[language] = (languageMap[language] || 0) + 1;
    });

    return languageMap;
  }

  /**
   * Get comprehensive guest analytics in one call
   * This reduces the number of round trips to Firestore
   */
  async getComprehensiveGuestAnalytics() {
    // Neither read depends on the other: running them in series was pure latency.
    const [summary, byDay] = await Promise.all([
      this.getGuestAnalyticsSummary(),
      this.getGuestActivityByDay(),
    ])

    if (summary) {
      const total = Number(summary.totalGuests || 0)
      const registered = Number(summary.guestConversions || 0)
      return {
        total,
        byCountry: this.toCountMapFromSummary(summary, 'byCountry', 'topCountries', 'country') || {},
        byBrowser: this.toCountMapFromSummary(summary, 'byBrowser', 'topBrowsers', 'browser') || {},
        byDevice: this.toCountMapFromSummary(summary, 'byDevice', 'topDevices', 'device') || {},
        byOS: this.toCountMapFromSummary(summary, 'byOS', 'topOperatingSystems', 'os') || {},
        byLanguage: this.toCountMapFromSummary(summary, 'byLanguage', 'topLanguages', 'language') || {},
        byTimezone: this.toCountMapFromSummary(summary, 'byTimezone', 'topTimezones', 'timezone') || {},
        registered,
        unregistered: Math.max(0, total - registered),
        byDay,
      }
    }

    const querySnapshot = await this.scanGuestsCollection()
    if (!querySnapshot) {
      return null;
    }

    const analytics = {
      total: querySnapshot.size,
      byCountry: {} as { [key: string]: number },
      byBrowser: {} as { [key: string]: number },
      byDevice: {} as { [key: string]: number },
      byOS: {} as { [key: string]: number },
      byLanguage: {} as { [key: string]: number },
      byTimezone: {} as { [key: string]: number },
      registered: 0,
      unregistered: 0,
      byDay: {} as { [key: string]: number }
    };

    querySnapshot.docs.forEach(doc => {
      const data = doc.data();

      // Country
      const country = data['country'] || 'Unknown';
      analytics.byCountry[country] = (analytics.byCountry[country] || 0) + 1;

      // Browser
      const browser = data['browser'] || 'Unknown';
      analytics.byBrowser[browser] = (analytics.byBrowser[browser] || 0) + 1;

      // Device
      const device = data['device'] || 'Unknown';
      analytics.byDevice[device] = (analytics.byDevice[device] || 0) + 1;

      // OS
      const os = data['os'] || 'Unknown';
      analytics.byOS[os] = (analytics.byOS[os] || 0) + 1;

      // Language
      const language = data['language'] || 'Unknown';
      analytics.byLanguage[language] = (analytics.byLanguage[language] || 0) + 1;

      // Timezone
      const timezone = data['timezone'] || 'Unknown';
      analytics.byTimezone[timezone] = (analytics.byTimezone[timezone] || 0) + 1;

      // Conversion
      if (data['uid'] || data['linkedAt']) {
        analytics.registered++;
      } else {
        analytics.unregistered++;
      }

      // Activity by day
      const createdAt = data['createdAt'];
      if (createdAt) {
        const date = createdAt.toDate ? createdAt.toDate() : new Date(createdAt);
        const dateKey = date.toISOString().split('T')[0];
        analytics.byDay[dateKey] = (analytics.byDay[dateKey] || 0) + 1;
      }
    });

    return analytics;
  }

  /**
   * This TypeScript function returns an observable that emits user data indicating whether a user is
   * currently authenticated.
   * @returns An observable that emits a boolean value indicating whether the user is authenticated or
   * not.
   */
  public authState(): Observable<User | null> {
    return runInInjectionContext(
      this._injector,
      (): Observable<User | null> => authState(this.afAuth).pipe(map((user: User | null) => user)), // Convert User | null to boolean
    )
  }


  /**
   * Note that the doc method could accept a CollectionReference or DocumentReference in addition to
   * Firestore.
   */
  public doc(path: string, ...pathSegments: string[]): DocumentReference {
    return runInInjectionContext(
      this._injector,
      (): DocumentReference => doc(this.firestore, path, ...pathSegments),
    )
  }

  /**
   * Note that the doc method could accept a CollectionReference or DocumentReference in addition to
   * Firestore.
   */
  public docRef<AppModelType, DbModelType extends DocumentData>(reference: CollectionReference<AppModelType, DbModelType>, path?: string, ...pathSegments: string[]): DocumentReference {
    return runInInjectionContext(
      this._injector,
      (): DocumentReference => doc(reference, path, ...pathSegments) as DocumentReference<DocumentData, DocumentData>,
    )
  }

  /**
   * This TypeScript function asynchronously retrieves a document from a Firestore database using the
   * provided user reference.
   * database. It is of type `DocumentReference<DocumentData>`, where `DocumentData` represents the
   * type of data stored in the document.
   * 
   * NOTE: Use this sparingly and only when absolutely necessary.
   * This is a band-aid solution for this issue:
   * https://github.com/angular/angularfire/issues/3621#issuecomment-2671369607
   ** @param userRef - The `userRef` parameter is a reference to a specific document in a Firestore
   ** @returns The `getDoc` function is returning a `Promise` that resolves to a `DocumentData` object.
   */
  public async getDoc(userRef: DocumentReference<DocumentData>): Promise<DocumentData> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<DocumentData> => {
        return await getDoc(userRef)
      },
    )
  }

  public docData<T = DocumentData>(userRef: DocumentReference<DocumentData>): Observable<T | undefined> {
    return runInInjectionContext(
      this._injector,
      (): Observable<T | undefined> => docData(userRef) as Observable<T | undefined>,
    )
  }

  public async addDoc(collectionRef: CollectionReference, data: unknown): Promise<DocumentReference<unknown, DocumentData>> {

    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<DocumentReference<unknown, DocumentData>> => {
        return await addDoc(collectionRef, data)
      },
    )
  }

  public newDocRef(collectionRef: CollectionReference): DocumentReference {
    return runInInjectionContext(
      this._injector,
      (): DocumentReference => doc(collectionRef),
    )
  }

  public collection(firestore: Firestore, path: string, ...pathSegments: string[]): CollectionReference {
    return runInInjectionContext(
      this._injector,
      (): CollectionReference => collection(firestore, path, ...pathSegments),
    )
  }

  public query(collectionRef: CollectionReference, ...queryConstraints: QueryConstraint[]): Query<DocumentData> {
    return runInInjectionContext(
      this._injector,
      (): Query<DocumentData> => query(collectionRef, ...queryConstraints),
    )
  }

  public where(fieldPath: string | FieldValue, opStr: any, value: any): QueryConstraint {
    return runInInjectionContext(
      this._injector,
      (): QueryConstraint => where(fieldPath, opStr, value),
    )
  }

  public limit(limits: number): QueryConstraint {
    return runInInjectionContext(
      this._injector,
      (): QueryConstraint => limit(limits),
    )
  }

  public orderBy(fieldPath: string, directionStr: 'asc' | 'desc' = 'asc'): QueryConstraint {
    return runInInjectionContext(
      this._injector,
      (): QueryConstraint => orderBy(fieldPath, directionStr),
    )
  }

  public getDocs(q: Query<DocumentData>): Promise<QuerySnapshot<DocumentData, DocumentData>> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<QuerySnapshot<DocumentData, DocumentData>> => {
        return await getDocs(q)
      },
    )
  }

  public async setDoc(userRef: DocumentReference<DocumentData>, data: unknown, options: SetOptions): Promise<void> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<void> => {
        await setDoc(userRef as DocumentReference<unknown, DocumentData>, data as Partial<unknown>, options)
      },
    )
  }

  public async deleteDoc(userRef: DocumentReference<DocumentData>): Promise<void> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<void> => {
        await deleteDoc(userRef)
      },
    )
  }

  public async ref(storage: FirebaseStorage, path: string): Promise<StorageReference> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<StorageReference> => {
        return ref(storage, path)
      },
    )
  }

  public async uploadString(storageRef: StorageReference, data: string,
    format: 'raw' | 'base64' | 'base64url' | 'data_url',
    metadata?: { [key: string]: any }): Promise<void> {

    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<void> => {
        await uploadString(storageRef, data, format, metadata)
      },
    )
  }

  public async getDownloadURL(storageRef: StorageReference): Promise<string> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<string> => {
        return await getDownloadURL(storageRef)
      },
    )
  }

  public writeBatch(): WriteBatch {
    return runInInjectionContext(
      this._injector,
      (): WriteBatch => writeBatch(this.firestore),
    )
  }


  public signInWithPopup(provider: any, resolver?: PopupRedirectResolver) {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<UserCredential> => {
        return await signInWithPopup(this.afAuth, provider, resolver)
      },
    )
  }

  public async signInWithEmailAndPassword(email: string, password: string): Promise<UserCredential> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<UserCredential> => {
        return await signInWithEmailAndPassword(this.afAuth, email, password)
      },
    )
  }

  public async reauthenticateWithCredential(currentUser: User, credential: AuthCredential): Promise<UserCredential> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<UserCredential> => {
        return await reauthenticateWithCredential(currentUser, credential)
      },
    )
  }
  public async linkWithPopup(currentUser: User, provider: any, resolver?: PopupRedirectResolver): Promise<UserCredential> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<UserCredential> => {
        return await linkWithPopup(currentUser, provider, resolver)
      },
    )
  }

  public async linkWithPhoneNumber(currentUser: User, phoneNumber: string, appVerifier: RecaptchaVerifier): Promise<ConfirmationResult> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<ConfirmationResult> => {
        return await linkWithPhoneNumber(currentUser, phoneNumber, appVerifier)
      },
    )
  }

  public async linkWithCredential(currentUser: User, credential: AuthCredential): Promise<UserCredential> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<UserCredential> => {
        return await linkWithCredential(currentUser, credential)
      },
    )
  }

  public async updatePassword(currentUser: User, newPassword: string): Promise<void> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<void> => {
        await updatePassword(currentUser, newPassword)
      },
    )
  }


  public async sendPasswordResetEmail(email: string, actactionCodeSettings?: ActionCodeSettings): Promise<void> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<void> => {
        await sendPasswordResetEmail(this.afAuth, email, actactionCodeSettings)
      },
    )
  }

  public async signOut(): Promise<void> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<void> => {
        await this.afAuth.signOut()
      },
    )
  }

  public getMultiFactorResolver(error: MultiFactorError): MultiFactorResolver {
    return runInInjectionContext(
      this._injector,
      (): MultiFactorResolver => getMultiFactorResolver(this.afAuth, error),
    )
  }

  public async verifyPhoneNumberForMfa(
    options: Parameters<PhoneAuthProvider['verifyPhoneNumber']>[0],
    appVerifier: RecaptchaVerifier,
  ): Promise<string> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<string> => {
        return await new PhoneAuthProvider(this.afAuth).verifyPhoneNumber(options, appVerifier)
      },
    )
  }

  public async resolveMultiFactorSignIn(resolver: MultiFactorResolver, assertion: Parameters<MultiFactorResolver['resolveSignIn']>[0]): Promise<UserCredential> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<UserCredential> => {
        return await resolver.resolveSignIn(assertion)
      },
    )
  }

  public async getMultiFactorSession(currentUser: User): Promise<MultiFactorSession> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<MultiFactorSession> => {
        return await multiFactor(currentUser).getSession()
      },
    )
  }

  public async generateTotpSecret(multiFactorSession: MultiFactorSession): Promise<TotpSecret> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<TotpSecret> => {
        return await TotpMultiFactorGenerator.generateSecret(multiFactorSession)
      },
    )
  }

  public async enrollMultiFactor(currentUser: User, assertion: Parameters<ReturnType<typeof multiFactor>['enroll']>[0], displayName?: string): Promise<void> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<void> => {
        await multiFactor(currentUser).enroll(assertion, displayName)
      },
    )
  }

  public async unenrollMultiFactor(currentUser: User, factorUid: string): Promise<void> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<void> => {
        await multiFactor(currentUser).unenroll(factorUid)
      },
    )
  }

  public async getRedirectResult(): Promise<UserCredential | null> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<UserCredential | null> => {
        return await getRedirectResult(this.afAuth)
      },
    )
  }

  public async updateUserProfile(user: User, profile: { displayName?: string | null; photoURL?: string | null }): Promise<void> {
    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<void> => {
        await updateProfile(user, profile)
      },
    )
  }

  public async callFunction<RequestData = void, ResponseData = unknown>(
    functionName: string,
    data?: RequestData,
  ): Promise<ResponseData> {
    if (!this.functions) {
      throw new Error('Firebase Functions is not available in the current injector context')
    }

    return this.runAsyncInInjectionContext(
      this._injector,
      async (): Promise<ResponseData> => {
        const callable = httpsCallable<RequestData, ResponseData>(this.functions!, functionName)
        const response = await callable(data as RequestData)
        return response.data
      },
    )
  }

  public setAnalyticsUserId(analytics: Analytics | null | undefined, userId: string): void {
    if (!analytics) {
      return
    }

    runInInjectionContext(
      this._injector,
      (): void => {
        setUserId(analytics, userId)
      },
    )
  }

  public logEvent(eventName: string, eventParams?: { [key: string]: any }): void {
    if (!isPlatformBrowser(this.platformId) || !this.analytics) {
      return
    }

    runInInjectionContext(
      this._injector,
      (): void => {
        try {
          logEvent(this.analytics!, eventName, eventParams)
        } catch (error) {
          console.warn('Analytics logEvent skipped:', error)
        }
      },
    )
  }

  private increment(value: number): FieldValue {
    return runInInjectionContext(
      this._injector,
      (): FieldValue => increment(value),
    )
  }

  /**
 * Runs an async function in the injection context. This can be awaited, unlike @see {runInInjectionContext}.
 * For some ungodly reason, only the first awaited call inside the fn callback is actually inside the injection context.
 * After something is awaited, the context is lost.
 *
 * NOTE: Use this sparingly and only when absolutely necessary.
 * This is a band-aid solution for this issue:
 * https://github.com/angular/angularfire/pull/3590#issuecomment-2581455741
 ** @param injector The injector, usually inject(EnvironmentInjector)
 ** @param fn The async callback to be awaited
 */
  async runAsyncInInjectionContext<T>(injector: Injector, fn: () => Promise<T>): Promise<T> {
    return await runInInjectionContext(injector, () => {
      return new Promise((resolve, reject) => {
        fn().then(resolve).catch(reject)
      })
    })
  }


  runOutsideAngular<T>(fn: () => T): T { // Helper function
    return this.ngZone.runOutsideAngular(fn)
  }
  runInsideAngular<T>(fn: () => T): T { // Helper function
    return this.ngZone.run(fn)
  }

  /**
 * Get total guest count efficiently
 */
  async getGuestCount(): Promise<number> {
    const guestsCollection = this.collection(this.firestore, 'guests');
    const q = this.query(guestsCollection);
    let err, querySnapshot = await this.getDocs(q);
    if (err) {
      console.error("Failed to get guests count:", err);
      return 0;
    }
    return querySnapshot.size;
  }

  /**
   * Get total authenticated user count efficiently
   */
  async getAuthenticatedUserCount(): Promise<number> {
    const metricsCollection = this.collection(this.firestore, 'login_metrics');
    const q = this.query(metricsCollection);
    let err, querySnapshot = await this.getDocs(q);
    if (err) {
      console.error("Failed to get login_metrics count:", err);
      return 0;
    }
    return querySnapshot.size;
  }

  /**
   * Get total login count and logins per day (aggregated)
   */
  async getLoginCountsByDay(limitDays: number = 7): Promise<{ [date: string]: number }> {
    // This assumes each login_metrics/{userId}/login_history_Info contains login events with a timestamp
    const metricsCollection = this.collection(this.firestore, 'login_metrics');
    const q = this.query(metricsCollection);
    let err, metricsSnapshot = await this.getDocs(q);
    if (err) {
      console.error("Failed to get login_metrics:", err);
      return {};
    }
    const result: { [date: string]: number } = {};
    for (const doc of metricsSnapshot.docs) {
      const userId = doc.id;
      const historyCollection = this.collection(this.firestore, `login_metrics/${userId}/login_history_Info`);
      const historyQ = this.query(historyCollection);
      let err2, historySnapshot = await this.getDocs(historyQ);
      if (err2) continue;
      for (const loginDoc of historySnapshot.docs) {
        const data = loginDoc.data();
        const ts = data['timestamp'] instanceof Date ? data['timestamp'] : (data['timestamp']?.toDate?.() ?? null);
        if (!ts) continue;
        const dateStr = ts.toISOString().slice(0, 10);
        result[dateStr] = (result[dateStr] || 0) + 1;
      }
    }
    // Optionally limit to last N days
    const sortedDates = Object.keys(result).sort().slice(-limitDays);
    const limitedResult: { [date: string]: number } = {};
    for (const date of sortedDates) limitedResult[date] = result[date];
    return limitedResult;
  }

  private sanitizeUserWrite(data: Partial<Users>): Partial<Users> {
    return Object.fromEntries(
      Object.entries(data).filter(([key, value]) => !this.protectedUserFields.has(key as keyof Users) && value !== undefined),
    ) as Partial<Users>
  }

  // ============================================================================
  // ANALYTICS METRICS METHODS (NEW ARCHITECTURE)
  // ============================================================================

  /**
   * Get dashboard summary (single read from metrics_summary/global)
   */
  async getDashboardSummary(): Promise<any | null> {
    try {
      const docRef = this.doc('metrics_summary/dashboard');
      const docSnap = await this.getDoc(docRef);
      return docSnap['exists']() ? docSnap['data']() : null;
    } catch (error) {
      console.error('Error getting dashboard summary:', error);
      return null;
    }
  }

  /**
   * Get metrics for a specific date
   */
  async getMetricsForDate(date: string): Promise<any | null> {
    try {
      const docRef = this.doc(`metrics_daily/${date}`);
      const docSnap = await this.getDoc(docRef);
      return docSnap['exists']() ? docSnap['data']() : null;
    } catch (error) {
      console.error('Error getting metrics for date:', error);
      return null;
    }
  }

  /**
   * Get metrics for date range (efficient query)
   */
  async getMetricsByDateRange(startDate: string, endDate: string): Promise<any[]> {
    try {
      const metricsCollection = this.collection(this.firestore, 'metrics_daily');
      const q = this.query(
        metricsCollection,
        this.where('date', '>=', startDate),
        this.where('date', '<=', endDate)
      );
      const snapshot = await this.getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Error getting metrics by date range:', error);
      return [];
    }
  }

  /**
   * Get pre-computed range metrics (single read)
   * @param rangeId - 'last-7d', 'last-30d', 'last-90d', etc.
   */
  async getRangeMetrics(rangeId: string): Promise<any | null> {
    try {
      const docRef = this.doc(`metrics_range/${rangeId}`);
      const docSnap = await this.getDoc(docRef);
      return docSnap['exists']() ? docSnap['data']() : null;
    } catch (error) {
      console.error('Error getting range metrics:', error);
      return null;
    }
  }

  /**
   * Billing snapshot (MRR, plan mix, trials, past due) from metrics_billing/current,
   * written nightly by computeBillingMetricsDaily. One read, no collection scan.
   */
  async getBillingMetrics(): Promise<any | null> {
    try {
      const docRef = this.doc('metrics_billing/current');
      const docSnap = await this.getDoc(docRef);
      return docSnap['exists']() ? docSnap['data']() : null;
    } catch (error) {
      console.error('Error getting billing metrics:', error);
      return null;
    }
  }

  /**
   * Get bucketed metrics by datetime key range.
   * Datetime key format: YYYY-MM-DD-HH, or YYYY-MM-DD-HH-mm for the minutely series.
   * @param collectionName - Bucketed series to read; every series shares the shape.
   */
  async getHourlyMetricsByDateTimeRange(
    startKey: string,
    endKey: string,
    collectionName: string = 'metrics_hourly'
  ): Promise<any[]> {
    try {
      const hourlyCollection = this.collection(this.firestore, collectionName);
      const q = this.query(
        hourlyCollection,
        this.where('datetime', '>=', startKey),
        this.where('datetime', '<=', endKey),
      );
      const snapshot = await this.getDocs(q);
      return snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .sort((a: any, b: any) => String(a.datetime || '').localeCompare(String(b.datetime || '')));
    } catch (error) {
      console.error('Error getting hourly metrics by datetime range:', error);
      return [];
    }
  }
  /**
   * Get login history for user (with pagination)
   * Reads from login_metrics/{userId}/login_history_Info subcollection
   */
  async getLoginHistoryNew(
    userId: string,
    startDate?: string,
    endDate?: string,
    limitCount: number = 50
  ): Promise<any[]> {
    try {
      const historyCollection = this.collection(
        this.firestore,
        `login_metrics/${userId}/login_history_Info`
      );
      
      const constraints: QueryConstraint[] = [this.limit(limitCount)];
      
      if (startDate) {
        constraints.push(this.where('timestamp', '>=', new Date(startDate)));
      }
      if (endDate) {
        constraints.push(this.where('timestamp', '<=', new Date(endDate)));
      }

      const q = this.query(historyCollection, ...constraints);
      const snapshot = await this.getDocs(q);
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Error getting login history:', error);
      return [];
    }
  }

  async getLoginHistoryEventsNew(
    userId: string,
    limitCount: number = 50,
  ): Promise<loginHistoryEvent[]> {
    try {
      const eventsCollection = this.collection(
        this.firestore,
        `login_metrics/${userId}/login_history_events`
      )

      const q = this.query(
        eventsCollection,
        this.orderBy('createdAt', 'desc'),
        this.limit(limitCount),
      )

      const snapshot = await this.getDocs(q)
      return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as loginHistoryEvent)
    } catch (error) {
      console.error('Error getting login history events:', error)
      return []
    }
  }

  /**
   * Get user login metrics summary (single read)
   * Reads from login_metrics/{userId} document
   */
  async getUserLoginMetricsNew(userId: string): Promise<any | null> {
    try {
      const docRef = this.doc(`login_metrics/${userId}`);
      const docSnap = await this.getDoc(docRef);
      return docSnap['exists']() ? docSnap['data']() : null;
    } catch (error) {
      console.error('Error getting user login metrics:', error);
      return null;
    }
  }

  // ============================================================================
  // END ANALYTICS METRICS METHODS
  // ============================================================================
}
