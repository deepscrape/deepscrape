import { DestroyRef, inject, Injectable, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  Auth, AuthProvider, authState, browserLocalPersistence, connectAuthEmulator, EmailAuthProvider, FacebookAuthProvider,
  getAuth,
  getMultiFactorResolver,
  GithubAuthProvider,
  GoogleAuthProvider, indexedDBLocalPersistence, linkWithPopup, multiFactor, MultiFactorInfo, MultiFactorResolver, PhoneAuthProvider, PhoneMultiFactorInfo, reauthenticateWithCredential, RecaptchaVerifier, setPersistence, signInWithCredential,
  PhoneMultiFactorGenerator,
  signInWithPhoneNumber,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  TotpMultiFactorGenerator,
  TotpSecret,
  unlink,
  updatePassword,
  User,
  UserCredential,
  UserInfo
} from '@angular/fire/auth';
import { Observable } from 'rxjs/internal/Observable';
import { Subscription } from 'rxjs/internal/Subscription';
import { Guest, loginHistoryInfo, Users } from '../types';
import { BehaviorSubject } from 'rxjs/internal/BehaviorSubject';
import { FirestoreService } from './firestore.service'
import { environment } from 'src/environments/environment';
import { from } from 'rxjs/internal/observable/from';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { catchError } from 'rxjs/internal/operators/catchError';
import { map } from 'rxjs/internal/operators/map';
import { tap } from 'rxjs/internal/operators/tap';
import { API_AUTH_FIREBASE } from '../variables';
import { cleanAndParseJSON, handleError } from '../functions';
import { throwError } from 'rxjs/internal/observable/throwError';
import { switchMap } from 'rxjs/internal/operators/switchMap';
import { firstValueFrom, of, pipe, timestamp } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HeartbeatService } from './heartbeat.service';
import { AnalyticsService } from './analytics.service';
import { GuestTrackingService } from './guest-tracking.service';

type TotpMfaProjectStatus = 'enabled' | 'already-enabled' | 'disabled' | 'already-disabled'

type TotpMfaProjectResponse = {
  success: boolean
  status: TotpMfaProjectStatus
  message: string
  config: {
    state: string
    adjacentIntervals: number
  }
}

export type MfaSecurityMethod = 'totp' | 'sms' | 'email'

export type MfaSecurityPreferences = {
  primaryMethod: MfaSecurityMethod
  secondaryMethod: MfaSecurityMethod | null
  riskEmailNotifications: boolean
  updatedAt: string
}

export type MfaSecurityPreferencesResult = {
  success: boolean
  preferences: MfaSecurityPreferences
  availableMethods: {
    totp: boolean
    sms: boolean
    email: boolean
  }
  hasEnrolledMfa?: boolean
}

export const MFA_SECURITY_PREFERENCES_KEY = 'mfa-security-preferences'

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly unsupportedMfaFirstFactors = new Set(['phone', 'anonymous', 'gc.apple.com'])

  private destroyRef = inject(DestroyRef)
   private platformId = inject<Object>(PLATFORM_ID);
  private heartbeatService = inject(HeartbeatService)
  private guestTrackingService = inject(GuestTrackingService)
  token: string | undefined = ''
  isAdmin: boolean = false
  private currentLoginId: string = ''

  private authStateResolved = new BehaviorSubject<boolean>(false)

  private userSubject = new BehaviorSubject<Users & { currProviderData: UserInfo | null } | null>(null);

  private userSubs: Subscription
  private authSubs: Subscription

  constructor(
    private auth: Auth, private fireService: FirestoreService,
    private http: HttpClient,

    private analyticsService: AnalyticsService

  ) {
    this.initAuth()

    this.heartbeatService.sessionRevoked$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.handleRevokedSession()
      })
  }

  private isBrowserRuntime(): boolean {
    return isPlatformBrowser(this.platformId);
  }

  private getAuthProviderData(user: User, userData: Users): UserInfo[] {
    return user.providerData.length > 0 ? user.providerData : (userData.providerData || [])
  }

  private normalizeSignInProvider(signInProvider: string | null | undefined): string {
    const normalized = String(signInProvider || '').trim()
    if (!normalized) return ''

    if (normalized === 'password' || normalized === 'phone' || normalized === 'anonymous' || normalized === 'custom') {
      return normalized
    }

    // Firebase claim values for OAuth providers are usually already '*.com'.
    return normalized
  }

  private getCurrentProviderId(
    user: User,
    userData: Users,
    providerData: UserInfo[],
    signInProvider?: string | null,
  ): string {
    // Keep UI "currently logged in with" stable to the app-tracked provider,
    // and avoid switching it during provider-link flows.
    if (userData.providerId && providerData.some((provider) => provider.providerId === userData.providerId)) {
      return userData.providerId
    }

    const normalizedSignInProvider = this.normalizeSignInProvider(signInProvider)
    if (normalizedSignInProvider && providerData.some((provider) => provider.providerId === normalizedSignInProvider)) {
      return normalizedSignInProvider
    }

    if (normalizedSignInProvider === 'password' || normalizedSignInProvider === 'phone') {
      return normalizedSignInProvider
    }

    return userData.providerId || providerData[0]?.providerId || user.providerData[0]?.providerId || ''
  }

  private buildCombinedUserData(
    user: User,
    userData: Users,
    emailVerifiedFromClaims: boolean | null,
    phoneVerifiedFromClaims: boolean | null,
    signInProvider?: string | null,
  ) {
    const providerData = this.getAuthProviderData(user, userData)
    const currentProviderId = this.getCurrentProviderId(user, userData, providerData, signInProvider)
    const currProviderData = providerData.find((provider: UserInfo) => provider.providerId === currentProviderId) || providerData[0] || null

    return {
      ...userData,
      uid: user.uid,
      email: user.email,
      emailVerified: user.emailVerified || emailVerifiedFromClaims || false,
      phoneNumber: user.phoneNumber || userData.phoneNumber || null,
      phoneVerified: phoneVerifiedFromClaims || userData.phoneVerified || null,
      providerParent: user.providerId || userData.providerParent || 'firebase',
      providerId: currentProviderId,
      providerData,
      currProviderData,
    }
  }

  private hasAdminRoleClaim(claims: Record<string, unknown> | undefined): boolean {
    if (!claims) {
      return false
    }

    const role = claims['role']
    return typeof role === 'string' && role.trim().toLowerCase() === 'admin'
  }

  private hasAdminFirestoreRole(userData: Users | null | undefined): boolean {
    const role = String(userData?.role || '').trim().toLowerCase()
    return role === 'admin'
  }

  isAuthenticated(): Observable<{ isAuthenticated: boolean, user: Users & { currProviderData: UserInfo | null } | null }> {
    return this.fireService.authState().pipe(
      map(user => ({ isAuthenticated: !!user, user })),
      switchMap(async isAuthData => {
        const { isAuthenticated, user } = isAuthData;

        if (!isAuthenticated || !user) {
          this.authStateResolved.next(false);
          this.userSubject.next(null);
          this.token = undefined;
          this.isAdmin = false;
          this.heartbeatService.stop(); // Stop heartbeat if not authenticated
          return { isAuthenticated: false, user: null }; // Ensure consistent return type
        }

        // Return cached user if already resolved
        // if (this.authStateResolved.value && this.userSubject.value) {
        //   return { isAuthenticated: true, user: this.userSubject.value };
        // }

        // Save token
        this.token = await user.getIdToken();

        const loginState = this.guestTrackingService.getSessionContext()
        if (loginState.loginId) {
          try {
            const sessionStatus = await this.fireService.callFunction<
              { loginId: string },
              { loginId: string; active: boolean; revoked: boolean }
            >('getMyLoginSessionStatus', { loginId: loginState.loginId })

            if (sessionStatus?.revoked || sessionStatus?.active === false) {
              this.handleRevokedSession()
              return { isAuthenticated: false, user: null }
            }
          } catch (sessionStatusError) {
            console.error('Failed to check login session status:', sessionStatusError)
          }
        }

        const userData = await this.fireService.getUserData(user.uid) as Users; // Firestore data

        if (!userData) throw new Error('No user data found');

        const getTokenResult = await user.getIdTokenResult(true) // Force-refresh token so newly set claims are available on first login

        // Extract custom claims for phoneVerified
        const phoneVerifiedFromClaims = getTokenResult.claims?.['phoneVerified'] === true; // Ensure it's explicitly true
        const emailVerifiedFromClaims = getTokenResult.claims?.['email_verified'] === true; // Capture custom claim
        const signInProvider = String((getTokenResult.claims as any)?.firebase?.sign_in_provider || '').trim()
        const combinedUserData: Users & { currProviderData: UserInfo | null } = this.buildCombinedUserData(
          user,
          userData,
          emailVerifiedFromClaims,
          phoneVerifiedFromClaims,
          signInProvider,
        )

        this.isAdmin = this.hasAdminRoleClaim(getTokenResult.claims as Record<string, unknown> | undefined) || this.hasAdminFirestoreRole(userData)
        console.log('User is admin:', this.isAdmin, getTokenResult.claims)

        // Save user data to the subject
        this.userSubject.next(combinedUserData);

        // Mark auth as resolved
        this.authStateResolved.next(true);
        this.heartbeatService.start(this.token); // Start heartbeat when authenticated

        // Return user data
        return { isAuthenticated: true, user: this.userSubject.value }
      }),
      catchError((error) => {
        console.error('Error in isAuthenticated:', error);
        this.authStateResolved.next(false)
        this.userSubject.next(null);
        this.token = undefined;
        this.isAdmin = false;
        return of({ isAuthenticated: false, user: null })
      })
    )
  }
  get isAuthStateResolved() {
    return this.authStateResolved.asObservable();
  }
  get user$(): Observable<Users & { currProviderData: UserInfo | null } | null> {
    return this.userSubject.asObservable();
  }
  /**
   * Refreshes user data after external changes (like email verification)
   * This updates the userSubject with fresh data from Firestore
   * If userId is provided, it refreshes that specific user, otherwise uses the current authenticated user
   * Useful when user profile changes outside of regular login flow
   * 
   * @param userId - Optional user ID to refresh. If not provided, uses current authenticated user
   * @throws Error if no user is found or data fetch fails
   */
  async refreshUserData(userId?: string): Promise<void | any> {
    try {
      const uid = userId || this.auth.currentUser?.uid;

      if (!uid) {
        throw new Error('No user ID provided and no authenticated user found');
      }

      // Refresh Firebase Auth user to get updated emailVerified flag (only if current user)
      let phoneVerifiedFromClaims: boolean | null = null
      let emailVerifiedFromClaims: boolean | null = null
      let signInProvider: string | null = null

      // Get fresh user data from Firestore first so admin fallback can safely use it.
      const userData = await this.fireService.refreshUserFromFirestore(uid) as Users;

      if (!userData) {
        throw new Error('User data not found in Firestore');
      }

      if (!userId && this.auth.currentUser) {
        await this.auth.currentUser.reload()
        const getTokenResult = await this.auth.currentUser.getIdTokenResult(true)
        phoneVerifiedFromClaims = getTokenResult.claims?.['phoneVerified'] === true; // Capture custom claim
        emailVerifiedFromClaims = getTokenResult.claims?.['email_verified'] === true; // Capture custom claim
        signInProvider = String((getTokenResult.claims as any)?.firebase?.sign_in_provider || '').trim()
        this.isAdmin = this.hasAdminRoleClaim(getTokenResult.claims as Record<string, unknown> | undefined) || this.hasAdminFirestoreRole(userData)
        console.log('User is admin after refresh:', this.isAdmin, getTokenResult.claims)
      }

      const authUser = this.auth.currentUser

      if (!authUser) {
        throw new Error('No authenticated user found while refreshing user data')
      }

      const combinedUserData: Users & { currProviderData: UserInfo | null } = this.buildCombinedUserData(
        authUser,
        userData,
        emailVerifiedFromClaims,
        phoneVerifiedFromClaims,
        signInProvider,
      )

      // Update the user subject with fresh data
      this.userSubject.next(combinedUserData);

      console.log('User data refreshed after verification');
      return combinedUserData;
    } catch (error) {
      console.error('Error refreshing user data:', error);
      throw error;
    }
  }

  // Update email verification status in backend
  updateEmailVerificationStatus(uid: string, emailVerified?: boolean): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>(
      `${API_AUTH_FIREBASE}/email/verification`,
      { uid }
    ).pipe(
      catchError((error) => {
        console.error('Email verification update error:', error);
        return throwError(() => error);
      })
    );
  }


  // Sign in with Google
  signInWithGoogle(provider: GoogleAuthProvider) {
    // Check if running in browser environment
    if (!this.isBrowserRuntime()) {
      return throwError(() => new Error('auth/operation-not-supported-in-this-environment'));
    }
    return from(this.fireService.signInWithPopup(provider)).pipe(
      switchMap((result) => this.emptyBackend(result.user.getIdToken(), provider.providerId, result)), // Use emptyBackend to avoid email enumaration protection 
      catchError((error) => {
        console.error('Google sign-in error:', error?.code);
        return throwError(() => error);
      })
    );
  }

  // Sign in with Facebook
  signInWithFacebook(provider: FacebookAuthProvider) {
    // Check if running in browser environment
    if (!this.isBrowserRuntime()) {
      return throwError(() => new Error('auth/operation-not-supported-in-this-environment'));
    }
    return from(this.fireService.signInWithPopup(provider)).pipe(
      switchMap((result) => this.emptyBackend(result.user.getIdToken(), provider.providerId, result)),
      catchError((error) => {
        console.error('Facebook sign-in error:', error?.code);
        return throwError(() => error);
      })
    );
  }

  // Sign in with GitHub
  signInWithGitHub(provider: GithubAuthProvider) {
    // Check if running in browser environment
    if (!this.isBrowserRuntime()) {
      return throwError(() => new Error('auth/operation-not-supported-in-this-environment'));
    }
    return from(this.fireService.signInWithPopup(provider)).pipe(
      switchMap((result) => this.emptyBackend(result.user.getIdToken(), provider.providerId, result)),
      catchError((error) => {
        console.error('Github sign-in error:', error?.code);
        return throwError(() => error);
      })
    );
  }

  async signInWithRedirectProvider(provider: AuthProvider): Promise<void> {
    if (!this.isBrowserRuntime()) {
      throw new Error('auth/operation-not-supported-in-this-environment');
    }

    await signInWithRedirect(this.auth, provider);
  }

  // Sign in with Email and Password
  signInWithEmail(email: string, password: string) {
    return from(this.fireService.signInWithEmailAndPassword(email, password)).pipe(
      switchMap((result) => this.emptyBackend(result.user.getIdToken(), 'password', result)),
      catchError((error) => {
        console.error('Email/Password sign-in error:', error?.code);
        return throwError(() => error)
      })
    );
  }

  async ensureBootstrapAdminAccess(providerId: string): Promise<boolean> {
    const isBootstrapProvider = providerId === 'google.com' || providerId === 'github.com'
    const currentUser = this.auth.currentUser

    if (!isBootstrapProvider || !currentUser) {
      return false
    }

    try {
      const response = await this.fireService.callFunction<
        { providerId: string },
        { success: boolean; role: string; email?: string | null }
      >('ensureBootstrapAdminAccess', { providerId })

      if (!response?.success) {
        return false
      }

      this.token = await currentUser.getIdToken(true)
      await this.refreshUserData(currentUser.uid)
      return response.role === 'admin'
    } catch (error: any) {
      const code = String(error?.code || '').toLowerCase()
      if (
        code.includes('permission-denied') ||
        code.includes('unauthenticated') ||
        code.includes('not-found')
      ) {
        return false
      }

      console.error('Bootstrap admin access sync failed:', error)
      return false
    }
  }

  async createBootstrapAdminPasswordAccount(email: string, password: string, displayName: string): Promise<{ success: boolean; uid: string; email: string }> {
    return await this.fireService.callFunction<
      { email: string; password: string; displayName: string },
      { success: boolean; uid: string; email: string }
    >('createBootstrapAdminPasswordAccount', {
      email,
      password,
      displayName,
    })
  }

  /**
   * Auto-detects identifier type and resolves it to an email before signing in.
   *
   * Detection order:
   *  - Contains `@`            → treat as email directly
   *  - Starts with `+`         → E.164 phone (resolved via BFF to email)
   *  - Otherwise               → username (resolved via BFF to email)
   */
  signInByIdentifier(identifier: string, password: string) {
    const isEmail = identifier.includes('@');
    const isPhone = identifier.startsWith('+');

    if (isEmail) {
      return this.signInWithEmail(identifier, password);
    }

    // Resolve phone/username → email via BFF, then sign in
    const endpoint = isPhone
      ? `${API_AUTH_FIREBASE}/resolve-identifier`
      : `${API_AUTH_FIREBASE}/resolve-identifier`;

    const body = isPhone ? { phone: identifier } : { username: identifier };

    return this.http
      .post<{ email: string }>(endpoint, body)
      .pipe(
        switchMap(({ email }) => this.signInWithEmail(email, password)),
        catchError((error) => {
          const firebaseCode = String(error?.code || '')
          // Preserve original Firebase auth errors so MFA resolver can read full payload.
          if (firebaseCode.startsWith('auth/')) {
            return throwError(() => error)
          }

          const code = error?.status === 404 ? 'auth/user-not-found' : 'auth/unknown'
          return throwError(() => ({ code, message: error?.error?.message ?? error?.message }))
        })
      );
  }

  /**
   * Resolve a username or E.164 phone to the registered email.
   * Used by UI to pre-populate or validate the identifier.
   */
  resolveLoginIdentifier(identifier: string): Observable<{ email: string }> {
    const isPhone = identifier.startsWith('+');
    const body = isPhone ? { phone: identifier } : { username: identifier };
    return this.http
      .post<{ email: string }>(`${API_AUTH_FIREBASE}/resolve-identifier`, body)
      .pipe(catchError((error) => throwError(() => error.error || error)));
  }

  // Phone sign-in methods
  async signInWithPhone(phoneNumber: string, appVerifier: RecaptchaVerifier) {
    return signInWithPhoneNumber(this.auth, phoneNumber, appVerifier);
  }

  // Link phone number to existing account
  async linkPhoneNumber(phoneNumber: string, appVerifier: RecaptchaVerifier) {
    const currentUser = this.auth.currentUser;
    if (!currentUser) throw new Error('No user logged in');

    return this.fireService.linkWithPhoneNumber(currentUser, phoneNumber, appVerifier);
  }
  // Check if phone number is available
  checkPhoneNumberAvailability(phoneNumber: string): Observable<{
    available: boolean,
    message?: string
  }> {
    return this.http.post<{ available: boolean, message?: string }>(
      `${API_AUTH_FIREBASE}/phone/verify`,
      { phoneNumber }
    ).pipe(
      catchError((error) => {
        console.error('Phone number check error:', error);
        return throwError(() => error);
      })
    );
  }

  // Check if phone number exists in the system
  checkPhoneNumberExists(phoneNumber: string): Observable<{
    exists: boolean
  }> {
    return this.http.post<{
      exists: boolean
    }>(`${API_AUTH_FIREBASE}/provider/phone/check`, { phoneNumber }).pipe(
      catchError((error) => {
        console.error('Phone number existence check error:', error);
        return throwError(() => error);
      })
    );
  }

  // Link phone number to current user account
  linkPhoneToCurrentUser(phoneNumber: string): Observable<{ success: boolean, message: string }> {
    const currentUser = this.auth.currentUser;
    if (!currentUser) {
      return throwError(() => new Error('No user logged in'));
    }

    return this.http.post<{ success: boolean, message: string }>(
      `${API_AUTH_FIREBASE}/phone/link`,
      { phoneNumber }
    ).pipe(
      catchError((error) => {
        console.error('Phone linking error:', error);
        return throwError(() => error);
      })
    );
  }

  // Update phone verification status in backend to set custom claims
  updatePhoneVerificationStatus(uid: string, phoneVerified?: boolean, phoneNumber?: string): Observable<{ success: boolean }> {
    const authHeaderToken = this.token || ''
    const headers = authHeaderToken
      ? new HttpHeaders({ Authorization: `Bearer ${authHeaderToken}` })
      : undefined

    return this.http.post<{ success: boolean }>(
      `${API_AUTH_FIREBASE}/phone/update-verification`,
      { uid, phoneVerified, phoneNumber },
      {
        headers,
        withCredentials: true,
      }
    ).pipe(
      catchError((error) => {
        console.error('Phone verification update error:', error);
        return throwError(() => error);
      })
    );
  }

  // Complete phone verification process
  async completePhoneVerification(confirmationResult: any, code: string): Promise<UserCredential> {
    try {
      const result = await confirmationResult.confirm(code);
      const currentUser = this.auth.currentUser;

      if (currentUser) {
        // Force a fresh token before syncing claims/status to backend.
        this.token = await currentUser.getIdToken(true)
        await firstValueFrom(this.updatePhoneVerificationStatus(currentUser.uid, true))

        // Refresh user data
        await this.refreshUserData()
      }

      return result;
    } catch (error) {
      console.error('Phone verification confirmation error:', error);
      throw error;
    }
  }

  getEnrolledMultiFactorHints(): readonly MultiFactorInfo[] {
    const currentUser = this.auth.currentUser;
    if (!currentUser) {
      return [];
    }

    return multiFactor(currentUser).enrolledFactors;
  }

  async startTotpEnrollment(): Promise<{
    secret: TotpSecret,
    secretKey: string,
    qrCodeUrl: string
  }> {
    const currentUser = this.auth.currentUser;
    if (!currentUser) {
      throw new Error('No user logged in');
    }

    const providerIds = currentUser.providerData
      .map((provider) => provider.providerId)
      .filter((providerId) => !!providerId)

    const hasSupportedFirstFactor = providerIds.some(
      (providerId) => !this.unsupportedMfaFirstFactors.has(providerId)
    )

    if (!hasSupportedFirstFactor) {
      throw new Error('Authenticator app MFA is not available for this sign-in method. Use email/password, Google, or GitHub as first factor, then enroll MFA.')
    }

    const multiFactorSession = await this.fireService.getMultiFactorSession(currentUser);
    let secret: TotpSecret;
    try {
      secret = await this.fireService.generateTotpSecret(multiFactorSession);
    } catch (error: any) {
      const rawMessage = String(error?.message || '').toUpperCase();
      if (rawMessage.includes('TOTP BASED MFA NOT ENABLED') || rawMessage.includes('OPERATION_NOT_ALLOWED')) {
        throw new Error('TOTP MFA is not enabled for this Firebase project. Enable TOTP in Firebase Auth > Multi-factor authentication.')
      }
      if (rawMessage.includes('UNSUPPORTED_FIRST_FACTOR')) {
        throw new Error('Authenticator app MFA is not available for the current sign-in method. Sign in with email/password, Google, or GitHub and try again.')
      }
      if (rawMessage.includes('MISSING PHONEENROLLMENTINFO') || rawMessage.includes('MISSING PHONE ENROLLMENT INFO')) {
        throw new Error('Your current Firebase Auth configuration requires SMS MFA to be enrolled first. Add SMS / Text message as a second factor, then enable authenticator app MFA.')
      }
      throw error
    }
    const accountLabel = currentUser.email || currentUser.uid;

    return {
      secret,
      secretKey: secret.secretKey,
      qrCodeUrl: secret.generateQrCodeUrl(accountLabel, 'deepscrape')
    };
  }

  async completeTotpEnrollment(secret: TotpSecret, verificationCode: string, displayName: string): Promise<void> {
    const currentUser = this.auth.currentUser;
    if (!currentUser) {
      throw new Error('No user logged in');
    }

    const assertion = TotpMultiFactorGenerator.assertionForEnrollment(secret, verificationCode);
    await this.fireService.enrollMultiFactor(currentUser, assertion, displayName.trim() || 'Authenticator app');
    await this.refreshUserData();
  }

  async startPhoneMfaEnrollment(phoneNumber: string, appVerifier: RecaptchaVerifier): Promise<string> {
    const currentUser = this.auth.currentUser
    if (!currentUser) {
      throw new Error('No user logged in')
    }

    const tokenResult = await currentUser.getIdTokenResult(true)
    const signInProvider = String((tokenResult.claims as any)?.firebase?.sign_in_provider || '').trim()
    if (this.unsupportedMfaFirstFactors.has(signInProvider)) {
      throw new Error('SMS MFA is not available for the current sign-in method. Sign in with email/password, Google, or GitHub and try again.')
    }

    const multiFactorSession = await this.fireService.getMultiFactorSession(currentUser)
    return await this.fireService.verifyPhoneNumberForMfa({ phoneNumber, session: multiFactorSession }, appVerifier)
  }

  async completePhoneMfaEnrollment(verificationId: string, code: string, displayName: string = 'SMS / Text message'): Promise<void> {
    const currentUser = this.auth.currentUser
    if (!currentUser) {
      throw new Error('No user logged in')
    }

    const credential = PhoneAuthProvider.credential(verificationId, code)
    const assertion = PhoneMultiFactorGenerator.assertion(credential)
    await this.fireService.enrollMultiFactor(currentUser, assertion, displayName.trim() || 'SMS / Text message')
    await this.refreshUserData()
  }

  async unenrollMultiFactor(enrollmentUid: string): Promise<void> {
    const currentUser = this.auth.currentUser;
    if (!currentUser) {
      throw new Error('No user logged in');
    }

    await this.fireService.unenrollMultiFactor(currentUser, enrollmentUid);
    await this.refreshUserData();
  }

  // ── MFA challenge resolution (sign-in / link with MFA required) ──────────

  getMfaResolverFromError(error: any): MultiFactorResolver | null {
    if (error?.code !== 'auth/multi-factor-auth-required') return null
    try {
      return getMultiFactorResolver(this.auth, error)
    } catch {
      return null
    }
  }

  async startPhoneMfaChallenge(
    resolver: MultiFactorResolver,
    hintUid: string,
    appVerifier: RecaptchaVerifier
  ): Promise<string> {
    const phoneFactor = resolver.hints.find(h => h.uid === hintUid) as PhoneMultiFactorInfo | undefined
    if (!phoneFactor) throw new Error('Phone factor hint not found')
    const provider = new PhoneAuthProvider(this.auth)
    return provider.verifyPhoneNumber(
      { multiFactorHint: phoneFactor, session: resolver.session },
      appVerifier
    )
  }

  async completeMfaPhoneChallenge(
    resolver: MultiFactorResolver,
    verificationId: string,
    code: string
  ): Promise<UserCredential> {
    const credential = PhoneAuthProvider.credential(verificationId, code)
    const assertion = PhoneMultiFactorGenerator.assertion(credential)
    return resolver.resolveSignIn(assertion)
  }

  async completeMfaTotpChallenge(
    resolver: MultiFactorResolver,
    hintUid: string,
    code: string
  ): Promise<UserCredential> {
    const assertion = TotpMultiFactorGenerator.assertionForSignIn(hintUid, code)
    return resolver.resolveSignIn(assertion)
  }

  private mapTotpProjectConfigError(error: any): never {
    const message = String(error?.message || '').toLowerCase()

    if (message.includes('permission-denied') || message.includes('administrator')) {
      throw new Error('Only administrators can update TOTP MFA project configuration.')
    }

    if (message.includes('service account') || message.includes('permission')) {
      throw new Error('The backend runtime is missing IAM permissions to update Firebase Auth project configuration.')
    }

    throw new Error(error?.message || 'Failed to update TOTP MFA project configuration')
  }

  /**
   * Enable TOTP MFA for the entire Firebase project.
   * Only administrators can invoke this function.
   * This must be done before users can enroll authenticator apps.
   */
  async setTotpMfaProjectEnabled(enabled: boolean): Promise<TotpMfaProjectResponse> {
    try {
      const result = await this.fireService.callFunction<
        { dryRun?: boolean; enabled?: boolean },
        TotpMfaProjectResponse
      >('enableTotpMfa', { dryRun: false, enabled });
      return result;
    } catch (error: any) {
      this.mapTotpProjectConfigError(error)
    }
  }

  async enableTotpMfaForProject(): Promise<TotpMfaProjectResponse> {
    return this.setTotpMfaProjectEnabled(true)
  }

  async getTotpMfaProjectStatus(): Promise<TotpMfaProjectResponse> {
    try {
      const result = await this.fireService.callFunction<
        { dryRun?: boolean },
        TotpMfaProjectResponse
      >('enableTotpMfa', { dryRun: true })
      return result
    } catch (error: any) {
      this.mapTotpProjectConfigError(error)
    }
  }

  async getMfaSecurityPreferences(): Promise<MfaSecurityPreferencesResult> {
    return await this.fireService.callFunction<
      Record<string, never>,
      MfaSecurityPreferencesResult
    >('getMfaSecurityPreferences', {})
  }

  async updateMfaSecurityPreferences(input: {
    primaryMethod: MfaSecurityMethod
    secondaryMethod: MfaSecurityMethod | null
    riskEmailNotifications: boolean
  }): Promise<MfaSecurityPreferencesResult> {
    const result = await this.fireService.callFunction<
      {
        primaryMethod: MfaSecurityMethod
        secondaryMethod: MfaSecurityMethod | null
        riskEmailNotifications: boolean
      },
      MfaSecurityPreferencesResult
    >('updateMfaSecurityPreferences', input)

    if (this.isBrowserRuntime()) {
      localStorage.setItem(MFA_SECURITY_PREFERENCES_KEY, JSON.stringify(result.preferences))
    }

    return result
  }

  readCachedMfaSecurityPreferences(): MfaSecurityPreferences | null {
    if (!this.isBrowserRuntime()) {
      return null
    }

    try {
      const raw = localStorage.getItem(MFA_SECURITY_PREFERENCES_KEY)
      if (!raw) {
        return null
      }

      const parsed = JSON.parse(raw) as Partial<MfaSecurityPreferences>
      if (!parsed || typeof parsed !== 'object') {
        return null
      }

      const primaryMethod = String(parsed.primaryMethod || '').trim().toLowerCase()
      if (primaryMethod !== 'totp' && primaryMethod !== 'sms' && primaryMethod !== 'email') {
        return null
      }

      const secondaryCandidate = String(parsed.secondaryMethod || '').trim().toLowerCase()
      const secondaryMethod = (secondaryCandidate === 'totp' || secondaryCandidate === 'sms' || secondaryCandidate === 'email') ?
        secondaryCandidate as MfaSecurityMethod :
        null

      return {
        primaryMethod: primaryMethod as MfaSecurityMethod,
        secondaryMethod,
        riskEmailNotifications: parsed.riskEmailNotifications !== false,
        updatedAt: String(parsed.updatedAt || ''),
      }
    } catch {
      return null
    }
  }

  async notifyMfaDisabledRisk(): Promise<void> {
    await this.fireService.callFunction<{ eventType: 'mfa_disabled' }, { success: boolean }>(
      'notifyMfaRiskEvent',
      { eventType: 'mfa_disabled' },
    )
  }

  async updatePassword(newPassword: string): Promise<UserCredential | null> {
    const currentUser = this.auth.currentUser;

    if (!currentUser) {
      throw new Error('No user logged in');
    }

    // Keep provider data in sync before deciding between link vs. update flows.
    await currentUser.reload();

    const email = currentUser.email?.trim();
    if (!email) {
      throw new Error('Current user does not have an email address.');
    }

    const isPasswordLinked = currentUser.providerData.some(
      (provider) => provider.providerId === EmailAuthProvider.PROVIDER_ID
    );

    if (isPasswordLinked) {
      await this.fireService.updatePassword(currentUser, newPassword)
      return null
    }

    try {
      // First-time setup for oauth users: attach email/password to the active account.
      const credential = EmailAuthProvider.credential(email, newPassword);
      return await this.linkWithCredential(credential)
    } catch (error: any) {
      const errorCode = error?.code || '';

      const canFallbackToUpdate =
        errorCode === 'auth/provider-already-linked' ||
        errorCode === 'auth/email-already-in-use' ||
        errorCode === 'auth/credential-already-in-use';

      if (canFallbackToUpdate) {
        await this.fireService.updatePassword(currentUser, newPassword)
        return null
      }

      console.error('Error updating password:', error);
      throw error;
    }
  }

  async reauthenticateWithPassword(currentPassword: string): Promise<void> {
    const currentUser = this.auth.currentUser;

    if (!currentUser) {
      throw new Error('No user logged in');
    }

    const isPasswordLinked = currentUser.providerData.some(
      (provider) => provider.providerId === EmailAuthProvider.PROVIDER_ID
    );

    if (!isPasswordLinked) {
      throw new Error('Password reauthentication is not available for this sign-in method.');
    }

    if (!currentUser.email) {
      throw new Error('Current user does not have an email for password reauthentication.');
    }

    const credential = EmailAuthProvider.credential(currentUser.email, currentPassword);
    await reauthenticateWithCredential(currentUser, credential);
    this.token = await currentUser.getIdToken(true);
  }

  // Verify and sign in with phone credential
  async verifyPhoneCode(verificationId: string, code: string) {
    const credential = PhoneAuthProvider.credential(verificationId, code);
    return signInWithCredential(this.auth, credential);
  }
  async linkWithCredential(credential: any) {
    const currentUser = this.auth.currentUser;
    if (!currentUser) throw new Error('No user logged in')
    return this.fireService.linkWithCredential(currentUser, credential)
  }


  // Link additional provider to existing account
  async linkProvider(provider: AuthProvider) {
    const currentUser = this.auth.currentUser
    if (currentUser) {
      if (!isPlatformBrowser(this.platformId)) {
        console.warn('linkWithPopup not available during SSR');
        return; // or throw error
      }

      const expectedUid = currentUser.uid
      const linked = await this.fireService.linkWithPopup(currentUser, provider)
      if (!linked?.user || linked.user.uid !== expectedUid) {
        throw new Error('Provider link aborted because auth context changed to a different account. Sign in again and retry linking from the original account.')
      }
      return linked
    } else {
      throw new Error('No user is currently signed in.');
    }
  }

  async unlinkProvider(providerId: string): Promise<void> {
    try {
      // type of providers: 'google.com', 'facebook.com', 'github.com', 'password', 'phone'
      const currentUser: User | null = this.auth.currentUser;

      if (!currentUser) {
        throw new Error('No user is currently signed in.');
      }

      const tokenResult = await currentUser.getIdTokenResult(true)
      const signInProvider = String((tokenResult.claims as any)?.firebase?.sign_in_provider || '').trim()
      if (signInProvider && signInProvider === providerId) {
        throw new Error(`Cannot unlink currently active sign-in provider (${providerId}).`)
      }

      // Check if the provider is linked
      const isProviderLinked = currentUser.providerData.some(
        (provider) => provider.providerId === providerId
      )

      if (!isProviderLinked) {
        throw new Error(`Provider ${providerId} is not linked to the current user.`)
      }

      // Unlink the provider from the current user
      const result = await unlink(currentUser, providerId);

      console.log(`Provider ${providerId} unlinked successfully.`, result)
    } catch (error) {
      console.error(`Error unlinking provider ${providerId}:`, error);
      throw error; // Re-throw the error for further handling
    }
  }


  /**
   * TODO: comment initAuth
   * @description Inits auth
   */
  initAuth() {

    if (!this.isBrowserRuntime()) {
      return null;
    }

    if (this.fireService.isLocalhost() && environment.emulators) {
      // Connect to Firebase Emulators if running on localhost and not in production
      console.log('🔥 Connecting Auth Service to Firebase Emulators');
      connectAuthEmulator(this.auth, 'http://localhost:9099');
    }
    // Optionally, fetch and return the current authenticated user data
    return null;
  }

  checkUserEmailForDifferentProvider(email: string): Observable<{
    exists: boolean,
    providers: string[],
    hasMultipleProviders: boolean
  }> {


    const url = `${API_AUTH_FIREBASE}/provider/email/${email}` // Replace with your API endpoint
    // const headers = {
    //   'api-key': `Bearer ${this.authService.token}`, // this is for the ssr express server `,
    //   'Authorization': `Bearer ${this.authService.token}`, // this is for the python fastapi server
    // }

    return this.http.get<{
      exists: boolean,
      providers: string[],
      hasMultipleProviders: boolean
    }>(url).pipe(
      tap((response) => {
        console.log('Check Email Existance:', response)
      }),
      map((response) => response),
      catchError((error) => throwError(() => error.error || 'Server error'))
    )
  }

  verifyAndLinkProvider(idToken: string, providerId: string): Observable<{ duplicateFound: boolean, existingUid?: string }> {
    const url = `${API_AUTH_FIREBASE}/verifyAndLink`
    const body = { idToken, providerId }
    return this.http.post<{ duplicateFound: boolean, existingUid?: string }>(url, body).pipe(
      catchError((error) => throwError(() => error.error || 'Server error'))
    );
  }
  private emptyBackend(idTokenPromise: Promise<string>, providerId: string, userCredential: any): Observable<{
    mergeRequired: boolean,
    user: User,
    result: UserCredential,
    credential?: any,
    existingUid?: string
  }> {

    return of({
      mergeRequired: false,
      user: userCredential.user,
      result: userCredential,
      credential: userCredential.credential,
      existingUid: "" // Include existingUid if provided by backend
    })
  }
  private sendTokenToBackend(idTokenPromise: Promise<string>, providerId: string, userCredential: any): Observable<{
    mergeRequired: boolean,
    user: User,
    result: UserCredential,
    credential?: any,
    existingUid?: string
  }> {
    return from(idTokenPromise).pipe(
      switchMap((idToken) => {
        const url = `${API_AUTH_FIREBASE}/verify-login`;

        const body = { idToken, providerId }
        return this.http.post(url, body).pipe(
          map((response: any) => {
            return {
              mergeRequired: response.mergeRequired,
              user: userCredential.user,
              result: userCredential,
              credential: userCredential.credential,
              existingUid: response.existingUid // Include existingUid if provided by backend
            };
          }),
          catchError((error) => throwError(() => error.error || 'Server error'))
        );
      })
    );
  }

  async linkGuestToUser(uid: string, guestId: string) {

    return await this.fireService.linkGuestToUser(uid, guestId)
  }

  async recordLoginMetrics(userId: string, metrics: Partial<loginHistoryInfo>, guestInfo?: Guest, sessionId?: string) {
    if (!metrics.providerId) {
      throw new Error("providerId is required for loginHistoryInfo");
    }
    // Cast metrics to loginHistoryInfo after ensuring required fields are present
    const result = await this.fireService.setUserLoginMetrics(userId, metrics as loginHistoryInfo, guestInfo, sessionId)
    // Store loginId in memory for use during logout
    if (result?.loginId) {
      this.currentLoginId = result.loginId
    }
    return result
  }

  logout() {
    const tokenTemp = this.token
    let { userId, loginId } = this.guestTrackingService.getSessionContext()
    userId = String(userId || this.userSubject.value?.uid || '')
    // Use in-memory loginId first, fallback to storage
    loginId = String(this.currentLoginId || loginId || '')

    // Immediately clear user state to prevent race conditions with Firestore listeners
    this.userSubject.next(null);
    this.authStateResolved.next(false);

    this.heartbeatService.stop(); // Stop heartbeat on logout

    return from(this.fireService.setSignOutMetrics(userId, loginId)).pipe(
      tap(() => {
        this.trackingLogout('logout', false, this.token)
        this.token = undefined
        this.isAdmin = false
        this.currentLoginId = ''
        this.guestTrackingService.clear()
      }),
      switchMap(() => from(this.fireService.signOut())),
      catchError(async (error) => {
        console.error('Logout error:', error)
        this.trackingLogout('logout', true, tokenTemp)
        // await this.fireService.signOut()
        return throwError(() => error)
      }
      ))
  }

  private trackingLogout(method: string, withError: boolean = false, token?: string) {
    try {
      // Only track if analyticsService and destroyRef are available
      if (this.analyticsService && this.destroyRef) {
        this.analyticsService.trackEvent('logout', {
          method: 'logout',
          withError,
          timestamp: new Date().toISOString()
        }, token, this.userSubject.value?.uid, this.guestTrackingService.getSessionContext().guestId || undefined)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe();
      }
    } catch (err) {
      console.warn('Analytics tracking failed during logout:', err);
    }
  }

  private handleRevokedSession(): void {
    this.currentLoginId = ''
    this.token = undefined
    this.isAdmin = false
    this.userSubject.next(null)
    this.authStateResolved.next(false)

    this.guestTrackingService.clear()

    this.fireService.signOut().catch((error) => {
      console.error('Failed to sign out after session revocation:', error)
    })
  }

  onSessionRevoked(): void {
    this.handleRevokedSession()
  }

  ngOnDestroy() {
    this.authSubs?.unsubscribe()
    this.userSubs?.unsubscribe()
  }
}
