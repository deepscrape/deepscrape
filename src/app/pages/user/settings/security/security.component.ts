import { isPlatformBrowser, JsonPipe, NgClass, UpperCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, DOCUMENT, inject, PLATFORM_ID, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Auth, ConfirmationResult, GithubAuthProvider, GoogleAuthProvider, MultiFactorInfo, MultiFactorResolver, RecaptchaVerifier, TotpSecret, updateProfile, UserCredential, UserInfo } from '@angular/fire/auth';
import { FormBuilder, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ActivatedRoute } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { from } from 'rxjs/internal/observable/from';
import { firstValueFrom } from 'rxjs';
import qrcodeGenerator from 'qrcode-generator';
import { CheckboxComponent, DialogComponent, RadioToggleComponent, SessionActivityComponent, SnackBarType, StinputComponent } from 'src/app/core/components';
import { createPasswordStrengthValidator, RippleDirective } from 'src/app/core/directives';
import { checkPasswordStrength, getErrorLabel, getErrorMessage } from 'src/app/core/functions';
import {
  mapSessionRecordToDisplaySession,
  resolveSessionIdFromRecord,
  getSessionNetworkSummary,
  getSessionProxySummary,
  getSessionRiskLabel,
  getSessionRiskLevel,
  getSessionRiskReason,
  getSessionRiskTone,
} from 'src/app/core/functions';
import { FormControlPipe } from 'src/app/core/pipes';
import { AuthService, AnalyticsService, DeviceVerificationService, FirestoreService, HighRiskActionService, LocalStorage, MfaSecurityMethod, SnackbarService, WebAuthnService } from 'src/app/core/services';
import { Loading, loginHistoryEvent, loginHistoryInfo, Users, SessionDisplayInfo } from 'src/app/core/types';
import { TrustedDevice } from 'src/app/core/services/device-verification.service';
import { WebAuthnCredential } from 'src/app/core/services/webauthn.service';
import { DEFAULT_PROFILE_URL } from 'src/app/core/variables';
import { myIcons, OtpInputComponent, themeStorageKey } from 'src/app/shared';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

type SecurityTimelineEvent = loginHistoryEvent & {
  occurredAt: Date | null
  sessionId: string
  locationLabel: string
  browserLabel: string
  osLabel: string
}

@Component({
  selector: 'app-security-tab',
  imports: [ReactiveFormsModule, StinputComponent, FormControlPipe, MatIcon, RippleDirective, UpperCasePipe, MatProgressSpinnerModule, LucideAngularModule, NgClass, OtpInputComponent, RadioToggleComponent, DialogComponent, SessionActivityComponent, TranslateModule, CheckboxComponent],
  templateUrl: './security.component.html',
  styleUrl: './security.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SecurityTabComponent {

  readonly icons = myIcons
  user: Users & { currProviderData: UserInfo | null } | null = null

  remProviders: string[]
  loginProviders: string[]

  loading: Loading = {
    github: false,
    google: false,
    logout: false,
    password: false,
    code: false,
    phone: false,
    email: false,
    mfa: false,
    remove: false
  }
  securityForm: FormGroup
  private localStorage = inject(LocalStorage)
  private analytics = inject(AnalyticsService)
  private route = inject(ActivatedRoute)
  private destroyRef = inject(DestroyRef)

  private authService = inject(AuthService)
  private firestoreService = inject(FirestoreService)
  private highRiskActionService = inject(HighRiskActionService)
  private snackbarService = inject(SnackbarService)
  private translate = inject(TranslateService)

  themeDarkMode: boolean

  hasProviderPassword = signal<{provider: string, has: boolean}>({provider: '', has: false})

  // ── Phone 2FA inline verification ──────────────────────────────────────────
  phoneStep = signal<'idle' | 'enter-number' | 'enter-code'>('idle')
  phoneError = signal('')
  accountPhoneStep = signal<'idle' | 'enter-number' | 'enter-code'>('idle')
  accountPhoneError = signal('')
  readonly phoneNumber = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^\+[1-9]\d{7,14}$/)] })
  readonly otpControl = new FormControl('', { nonNullable: true })
  readonly accountPhoneNumber = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^\+[1-9]\d{7,14}$/)] })
  readonly accountPhoneCode = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^\d{6}$/)] })
  readonly mfaStatusControl = new FormControl(false, { nonNullable: true })
  readonly mfaPrimaryControl = new FormControl<MfaSecurityMethod>('email', { nonNullable: true })
  readonly mfaSecondaryControl = new FormControl<MfaSecurityMethod | 'none'>('none', { nonNullable: true })
  readonly riskEmailNotificationsControl = new FormControl(true, { nonNullable: true })
  readonly totpCode = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^\d{6}$/)] })
  readonly totpDisplayName = new FormControl('Authenticator app', { nonNullable: true, validators: [Validators.required, Validators.maxLength(40)] })
  private recaptchaVerifier!: RecaptchaVerifier
  private phoneMfaVerificationId = ''
  private accountPhoneConfirmationResult: ConfirmationResult | null = null
  private pendingTotpSecret: TotpSecret | null = null
  private readonly platformId = inject(PLATFORM_ID)
  private readonly document = inject(DOCUMENT)
  private readonly fireAuth = inject(Auth)
  private readonly deviceVerificationService = inject(DeviceVerificationService)
  private readonly webAuthnService = inject(WebAuthnService)
  readonly totpStep = signal<'idle' | 'verify'>('idle')
  readonly totpError = signal('')
  readonly totpSecretKey = signal('')
  readonly totpQrUrl = signal('')
  readonly totpQrCodeDataUrl = signal('')
  readonly totpFactors = signal<readonly MultiFactorInfo[]>([])
  readonly phoneMfaFactors = signal<readonly MultiFactorInfo[]>([])
  // PHASE 2.2: Updated type to SessionDisplayInfo for enterprise sessions
  readonly activeSessions = signal<SessionDisplayInfo[]>([])
  readonly sessionsLoading = signal(false)
  readonly sessionsError = signal('')
  readonly activityTimeline = signal<SecurityTimelineEvent[]>([])
  readonly activityLoading = signal(false)
  readonly activityError = signal('')
  readonly revokingSessionId = signal('')
  readonly trustedDevices = signal<TrustedDevice[]>([])
  readonly trustedDevicesLoading = signal(false)
  readonly trustedDevicesError = signal('')
  readonly revokingDeviceId = signal('')
  readonly passkeys = signal<WebAuthnCredential[]>([])
  readonly passkeysLoading = signal(false)
  readonly isRegisteringPasskey = signal(false)
  readonly passkeyError = signal('')
  readonly currentSessionId = signal('')
  readonly confirmationDialog = signal<'disable-mfa' | 'disable-totp-factor' | 'revoke-current-session' | null>(null)
  readonly pendingSessionToRevoke = signal<(SessionDisplayInfo & { id?: string }) | null>(null)
  readonly pendingTotpFactorToRemove = signal<MultiFactorInfo | null>(null)
  readonly mfaPreferencesLoading = signal(false)
  readonly mfaPreferencesSaving = signal(false)
  readonly mfaPreferencesError = signal('')
  readonly availableMfaMethods = signal<{ totp: boolean; sms: boolean; email: boolean }>({
    totp: false,
    sms: false,
    email: true,
  })
  private pendingEnrichmentRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private pendingEnrichmentRefreshAttempts = 0
  private readonly maxPendingEnrichmentRefreshAttempts = 2

  // ── MFA challenge state for provider linking (when user has MFA enabled) ──
  readonly mfaLinkResolver = signal<MultiFactorResolver | null>(null)
  readonly mfaLinkProvider = signal<'google' | 'github' | ''>('')
  readonly mfaLinkStep = signal<'idle' | 'phone-code' | 'totp-code'>('idle')
  readonly mfaLinkVerificationId = signal('')
  readonly mfaLinkPhoneHint = signal('')
  readonly mfaLinkPhoneFactorIndex = signal(0) // Track which phone factor we're trying
  readonly mfaLinkPhoneFactorAttempts = signal<{factorUid: string, phoneNumber: string, error: string}[]>([]) // Track failed attempts
  readonly mfaLinkOtp = new FormControl('', { nonNullable: true })
  readonly mfaLinkTotpCode = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^\d{6}$/)] })
  readonly mfaLinkError = signal('')


  public get email() {
    return this.securityForm.get('email')
  }

  public get password() {
    return this.securityForm.get('password')
  }

  constructor(private cdr: ChangeDetectorRef, private fb: FormBuilder,) {

    this.themeDarkMode = this.localStorage?.getItem(themeStorageKey) === 'true'
  }


  ngOnInit(): void {
    //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
    //Add 'implements OnInit' to the class.
    this.initSecurityForm()
    this.initProviders()
    void this.loadMfaPreferences()
    void this.loadTrustedDevices()
    void this.loadPasskeys()

    this.destroyRef.onDestroy(() => {
      if (this.pendingEnrichmentRefreshTimer) {
        clearTimeout(this.pendingEnrichmentRefreshTimer)
        this.pendingEnrichmentRefreshTimer = null
      }
    })
  }


  private initSecurityForm() {

    // set user data from resolver
    this.initUser()

    // initialize form
    this.securityForm = this.fb.group({

      email: this.fb.control<string>(this.user?.email ?? '',
        {
          updateOn: 'change', //default will be change
          validators: [
            Validators.required,
            Validators.email,
            Validators.pattern('^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,4}$')
          ]
        }),
      password: this.fb.control<string>('', {
        updateOn: 'change', //default will be
        nonNullable: true,
        validators: [
          Validators.minLength(8),
          // Strong Password Validation
          createPasswordStrengthValidator(),
          // Strong Password Validation
          // forbiddenNameValidator(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/i)
        ]
      })
    })

    this.email?.disable()

    this.mfaStatusControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => {
        void this.onMfaStatusSelected(value)
      })

    this.mfaPrimaryControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => {
        const secondary = this.mfaSecondaryControl.value
        if (secondary === value) {
          this.mfaSecondaryControl.setValue('none', { emitEvent: false })
        }
      })
  }

  private getPreferredMfaMethod(): MfaSecurityMethod {
    return this.mfaPrimaryControl.value
  }

  isMethodAvailable(method: MfaSecurityMethod): boolean {
    return this.availableMfaMethods()[method]
  }

  isPrimaryMethod(method: MfaSecurityMethod): boolean {
    return this.mfaPrimaryControl.value === method
  }

  private async loadTrustedDevices(): Promise<void> {
    if (!this.user?.uid) return

    this.trustedDevicesLoading.set(true)
    this.trustedDevicesError.set('')

    try {
      const devices = await firstValueFrom(this.deviceVerificationService.getTrustedDevices(this.user.uid))
      this.trustedDevices.set(devices)
    } catch (error) {
      console.error('Failed to load trusted devices:', error)
      this.trustedDevicesError.set(this.translate.instant('SETTINGS_SECURITY.FAILED_LOAD_TRUSTED'))
    } finally {
      this.trustedDevicesLoading.set(false)
    }
  }

  async removeTrustedDevice(deviceId: string): Promise<void> {
    if (!this.user?.uid) return

    this.revokingDeviceId.set(deviceId)

    try {
      const success = await this.deviceVerificationService.removeTrustedDevice(this.user.uid, deviceId)
      if (success) {
        this.trustedDevices.update((devices) => devices.filter((d) => d.deviceId !== deviceId))
        this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.DEVICE_TRUST_REVOKED'), SnackBarType.success, '', 3000)
      } else {
        this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.DEVICE_TRUST_REVOKE_FAILED'), SnackBarType.error, '', 5000)
      }
    } catch (error) {
      console.error('Failed to remove trusted device:', error)
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.DEVICE_TRUST_REVOKE_FAILED'), SnackBarType.error, '', 5000)
    } finally {
      this.revokingDeviceId.set('')
    }
  }

  async revokeAllTrustedDevices(): Promise<void> {
    if (!this.user?.uid) return

    const devices = this.trustedDevices()
    for (const device of devices) {
      await this.removeTrustedDevice(device.deviceId)
    }
  }

  getDeviceDisplayName(device: TrustedDevice): string {
    return device.deviceName || this.translate.instant('SETTINGS_SECURITY.UNKNOWN_DEVICE')
  }

  getDeviceBrowser(device: TrustedDevice): string {
    return device.browser || device.fingerprint?.userAgent?.slice(0, 50) || this.translate.instant('SETTINGS_SECURITY.UNKNOWN')
  }

  getDeviceOs(device: TrustedDevice): string {
    return device.os || ''
  }

  getDeviceLocation(device: TrustedDevice): string {
    return device.location || this.translate.instant('SETTINGS_SECURITY.UNKNOWN_LOCATION')
  }

  formatTrustedDate(date: Date | undefined): string {
    if (!date) return this.translate.instant('SETTINGS_SECURITY.NA')
    try {
      return new Date(date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return this.translate.instant('SETTINGS_SECURITY.NA')
    }
  }

  private async loadPasskeys(): Promise<void> {
    if (!this.user?.uid) return

    this.passkeysLoading.set(true)
    try {
      await this.webAuthnService.loadPasskeys()
      this.passkeys.set(this.webAuthnService.passkeys())
      this.passkeyError.set('')
    } catch (error) {
      console.error('Failed to load passkeys:', error)
      this.passkeyError.set(this.translate.instant('SETTINGS_SECURITY.FAILED_LOAD_PASSKEYS'))
    } finally {
      this.passkeysLoading.set(false)
    }
  }

  async registerPasskey(): Promise<void> {
    this.isRegisteringPasskey.set(true)
    this.passkeyError.set('')
    try {
      const success = await this.webAuthnService.registerPasskey()
      if (success) {
        this.passkeys.set(this.webAuthnService.passkeys())
        this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.PASSKEY_REGISTERED'), SnackBarType.success, '', 3000)
      } else {
        this.passkeyError.set(this.webAuthnService.error() || this.translate.instant('SETTINGS_SECURITY.PASSKEY_REGISTER_FAILED'))
      }
    } catch (error) {
      console.error('Passkey registration error:', error)
      this.passkeyError.set(this.translate.instant('SETTINGS_SECURITY.PASSKEY_REGISTER_FAILED'))
    } finally {
      this.isRegisteringPasskey.set(false)
    }
  }

  async removePasskey(credentialDocId: string): Promise<void> {
    try {
      const success = await this.webAuthnService.removePasskey(credentialDocId)
      if (success) {
        this.passkeys.set(this.webAuthnService.passkeys())
        this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.PASSKEY_REMOVED'), SnackBarType.success, '', 3000)
      } else {
        this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.PASSKEY_REMOVE_FAILED'), SnackBarType.error, '', 5000)
      }
    } catch (error) {
      console.error('Failed to remove passkey:', error)
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.PASSKEY_REMOVE_FAILED'), SnackBarType.error, '', 5000)
    }
  }

  async loadMfaPreferences(): Promise<void> {
    this.mfaPreferencesLoading.set(true)
    this.mfaPreferencesError.set('')
    this.cdr.detectChanges()

    try {
      const result = await this.authService.getMfaSecurityPreferences()
      this.availableMfaMethods.set(result.availableMethods)
      this.mfaPrimaryControl.setValue(result.preferences.primaryMethod, { emitEvent: false })
      this.mfaSecondaryControl.setValue(result.preferences.secondaryMethod || 'none', { emitEvent: false })
      this.riskEmailNotificationsControl.setValue(result.preferences.riskEmailNotifications, { emitEvent: false })
    } catch (error: any) {
      this.mfaPreferencesError.set(this.getMfaErrorMessage(error))
    } finally {
      this.mfaPreferencesLoading.set(false)
      this.cdr.detectChanges()
    }
  }

  async saveMfaPreferences(): Promise<void> {
    if (this.mfaPreferencesSaving()) {
      return
    }

    this.mfaPreferencesSaving.set(true)
    this.mfaPreferencesError.set('')
    this.cdr.detectChanges()

    try {
      const secondary = this.mfaSecondaryControl.value === 'none' ? null : this.mfaSecondaryControl.value
      const result = await this.authService.updateMfaSecurityPreferences({
        primaryMethod: this.mfaPrimaryControl.value,
        secondaryMethod: secondary,
        riskEmailNotifications: this.riskEmailNotificationsControl.value,
      })

      this.availableMfaMethods.set(result.availableMethods)
      this.mfaPrimaryControl.setValue(result.preferences.primaryMethod, { emitEvent: false })
      this.mfaSecondaryControl.setValue(result.preferences.secondaryMethod || 'none', { emitEvent: false })
      this.riskEmailNotificationsControl.setValue(result.preferences.riskEmailNotifications, { emitEvent: false })
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.MFA_PREFS_SAVED'), SnackBarType.success, '', 2500)
      // No mfa_enabled emit here: `MfaSecurityMethod` has no 'none' member, so a
      // none -> method transition cannot occur in this method. Enrolment is the
      // enable path (see the factor verification handlers).
    } catch (error: any) {
      this.mfaPreferencesError.set(this.getMfaErrorMessage(error))
      this.showSnackbar(this.mfaPreferencesError(), SnackBarType.error, '', 4500)
    } finally {
      this.mfaPreferencesSaving.set(false)
      this.cdr.detectChanges()
    }
  }

  initUser() {
    this.user = this.route.snapshot.data['user']
    this.hasProviderPassword.set({provider: this.getCurrentProviderId(), 
      has: this.user?.providerData.some(p => p.providerId === 'password') ?? false})
    this.syncTotpFactors()
    this.resolveCurrentSessionId()
    this.loadActiveSessions()
    this.loadActivityTimeline()
  }

  private resolveCurrentSessionId(): void {
    if (!isPlatformBrowser(this.platformId)) {
      this.currentSessionId.set('')
      return
    }

    try {
      const cookiePairs = this.document.cookie
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.startsWith('aid='))

      const aidRaw = cookiePairs.length > 0 ? decodeURIComponent(cookiePairs[0].slice(4)) : ''
      const aidData = aidRaw ? JSON.parse(aidRaw) as { loginId?: string } : null
      const loginId = aidData?.loginId || this.localStorage.getItem('loginId') || ''
      this.currentSessionId.set(loginId)
    } catch {
      this.currentSessionId.set(this.localStorage.getItem('loginId') || '')
    }
  }

  loadActiveSessions(options: { silent?: boolean } = {}): void {
    const { silent = false } = options

    if (!this.user?.uid) {
      this.activeSessions.set([])
      return
    }

    if (!silent) {
      this.sessionsLoading.set(true)
      this.sessionsError.set('')
    }

    this.firestoreService.getMyLoginSessionsWithFallback(25)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (sessions) => {
          // PHASE 2.2: Transform sessions to SessionDisplayInfo format
          const displaySessions: SessionDisplayInfo[] = (sessions || []).map((s: any) =>
            mapSessionRecordToDisplaySession(s, {
              defaultUserId: this.user?.uid || '',
              currentSessionId: this.currentSessionId(),
            }),
          )
          this.activeSessions.set(displaySessions)

          if (!silent) {
            this.sessionsLoading.set(false)
          }

          if (displaySessions.some((session) => String(session.intelligenceStatus || '').toLowerCase() === 'pending')) {
            this.schedulePendingEnrichmentRefresh()
          } else {
            this.pendingEnrichmentRefreshAttempts = 0
          }

          this.cdr.detectChanges()
        },
        error: (error) => {
          if (!silent) {
            this.sessionsLoading.set(false)
            this.sessionsError.set(getErrorMessage(error, this.translate))
          } else {
            console.warn('Silent active session refresh failed:', error)
          }
          this.cdr.detectChanges()
        }
      })
  }

  private schedulePendingEnrichmentRefresh(): void {
    if (this.pendingEnrichmentRefreshTimer) {
      return
    }

    if (this.pendingEnrichmentRefreshAttempts >= this.maxPendingEnrichmentRefreshAttempts) {
      return
    }

    this.pendingEnrichmentRefreshAttempts += 1
    this.pendingEnrichmentRefreshTimer = setTimeout(() => {
      this.pendingEnrichmentRefreshTimer = null
      this.loadActiveSessions({ silent: true })
    }, 3000)
  }

  loadActivityTimeline(): void {
    if (!this.user?.uid) {
      this.activityTimeline.set([])
      return
    }

    this.activityLoading.set(true)
    this.activityError.set('')

    this.firestoreService.getMyLoginHistoryEvents(20)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (events) => {
          const timeline = (events || []).map((event) => {
            const occurredAt = this.resolveSessionDate(event, [
              'createdAt',
              'timestamp',
              'signOutTime',
              'revokedAt',
            ])
            const browserLabel = this.getEventBrowser(event)
            const osLabel = this.getEventOS(event)

            return {
              ...event,
              occurredAt,
              sessionId: this.resolveEventSessionId(event),
              locationLabel: this.resolveSessionLocation(event),
              browserLabel,
              osLabel,
            }
          })

          this.activityTimeline.set(timeline)
          this.activityLoading.set(false)
          this.cdr.detectChanges()
        },
        error: (error) => {
          this.activityLoading.set(false)
          this.activityError.set(getErrorMessage(error, this.translate))
          this.cdr.detectChanges()
        }
      })
  }

  isCurrentSession(session: SessionDisplayInfo & { id?: string }): boolean {
    const sessionId = resolveSessionIdFromRecord(session)
    return !!sessionId && sessionId === this.currentSessionId()
  }

  getSessionForVisualization(): SessionDisplayInfo | null {
    const sessions = this.activeSessions()
    if (!sessions.length) {
      return null
    }

    const currentSession = sessions.find((session) => this.isCurrentSession(session))
    return currentSession || sessions[0]
  }

  canRevokeSession(session: SessionDisplayInfo): boolean {
    const connected = (session as any)?.connected ?? session.active
    const revokedAt = (session as any)?.revokedAt ?? session.revokedAt
    const signOutTime = (session as any)?.signOutTime ?? null
    return connected === true && !revokedAt && !signOutTime
  }

  formatSessionTimestamp(session: SessionDisplayInfo): string {
    // Use pre-formatted humanReadableTime from SessionDisplayInfo
    if (session.humanReadableTime && session.humanReadableTime !== 'Unknown time') {
      return session.humanReadableTime
    }
    const dateValue = this.resolveSessionDate(session as any, [
      'timestamp',
      'createdAt',
      'lastSignInTime',
      'signInTime',
      'created_At',
    ])
    return dateValue ? dateValue.toLocaleString() : this.translate.instant('SETTINGS_SECURITY.UNKNOWN_TIME')
  }

  getDisplayBrowser(session: SessionDisplayInfo): string {
    const explicit = (session.browser || '').trim()
    if (explicit && explicit.toLowerCase() !== 'unknown') {
      return explicit
    }

    return this.detectBrowserFromUserAgent(session.userAgent || '')
  }

  getDisplayOS(session: SessionDisplayInfo): string {
    const explicit = (session.os || '').trim()
    if (explicit && explicit.toLowerCase() !== 'unknown') {
      return explicit
    }

    return this.detectOsFromUserAgent(session.userAgent || '')
  }

  getSessionRiskLevel(session: SessionDisplayInfo): 'pending' | 'low' | 'medium' | 'high' {
    return getSessionRiskLevel(session)
  }

  getSessionRiskTone(session: SessionDisplayInfo): string {
    return getSessionRiskTone(session)
  }

  getSessionRiskLabel(session: SessionDisplayInfo): string {
    return getSessionRiskLabel(session, (k, p) => this.translate.instant(k, p))
  }

  getSessionRiskReason(session: SessionDisplayInfo): string {
    return getSessionRiskReason(session, (k, p) => this.translate.instant(k, p))
  }

  getSessionNetworkSummary(session: SessionDisplayInfo): string {
    return getSessionNetworkSummary(session, (k, p) => this.translate.instant(k, p))
  }

  getSessionProxySummary(session: SessionDisplayInfo): string {
    return getSessionProxySummary(session, (k, p) => this.translate.instant(k, p))
  }

  async revokeSession(session: SessionDisplayInfo & { id?: string }): Promise<void> {
    const loginId = resolveSessionIdFromRecord(session)
    if (!loginId || this.revokingSessionId()) return

    if (this.isCurrentSession(session)) {
      this.openCurrentSessionRevokeDialog(session)
      return
    }

    this.runSessionRevoke(session)
  }

  private asDate(input: any): Date | null {
    if (!input) return null
    if (input instanceof Date) return input
    if (typeof input?.toDate === 'function') return input.toDate()
    if (typeof input?.seconds === 'number') return new Date(input.seconds * 1000)
    if (typeof input === 'string' || typeof input === 'number') {
      const date = new Date(input)
      return isNaN(date.getTime()) ? null : date
    }
    return null
  }

  private resolveEventSessionId(event: loginHistoryEvent): string {
    return String(
      event.eventSessionId ||
      event.sessionKey ||
      event.id ||
      ''
    )
  }

  private resolveSessionDate(session: any, keys: string[]): Date | null {
    for (const key of keys) {
      const parsed = this.asDate(session?.[key])
      if (parsed) {
        return parsed
      }
    }
    return null
  }

  private resolveSessionLocation(session: any): string {
    const direct = String(session?.location || '').trim()
    if (direct && direct.toLowerCase() !== 'unknown') {
      return direct
    }

    const guestLocation = String(session?.guestInfo?.location || '').trim()
    if (guestLocation && guestLocation.toLowerCase() !== 'unknown') {
      return guestLocation
    }

    const country = String(session?.country || '').trim()
    const region = String(session?.region || '').trim()
    return [region, country].filter(Boolean).join(', ')
  }

  private detectBrowserFromUserAgent(userAgent: string): string {
    const ua = (userAgent || '').toLowerCase()
    if (ua.includes('edg')) return 'Edge'
    if (ua.includes('opr') || ua.includes('opera')) return 'Opera'
    if (ua.includes('firefox')) return 'Firefox'
    if (ua.includes('chrome') && !ua.includes('edg')) return 'Chrome'
    if (ua.includes('safari') && !ua.includes('chrome')) return 'Safari'
    return this.translate.instant('SETTINGS_SECURITY.UNKNOWN_BROWSER')
  }

  private detectOsFromUserAgent(userAgent: string): string {
    const ua = (userAgent || '').toLowerCase()
    if (ua.includes('windows')) return 'Windows'
    if (ua.includes('mac os') || ua.includes('macintosh')) return 'macOS'
    if (ua.includes('android')) return 'Android'
    if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) return 'iOS'
    if (ua.includes('linux')) return 'Linux'
    return this.translate.instant('SETTINGS_SECURITY.UNKNOWN_OS')
  }

  getActivityEventLabel(event: SecurityTimelineEvent): string {
    if (event.eventType === 'mfa_preference_updated') return this.translate.instant('SETTINGS_SECURITY.ACT_MFA_PREFS_UPDATED')
    if (event.eventType === 'mfa_disabled') return this.translate.instant('SETTINGS_SECURITY.ACT_MFA_DISABLED')
    if (event.eventType === 'logout') return this.translate.instant('SETTINGS_SECURITY.ACT_SIGNED_OUT')
    if (event.eventType === 'revoke') return this.translate.instant('SETTINGS_SECURITY.ACT_SESSION_REVOKED')
    return this.translate.instant('SETTINGS_SECURITY.ACT_SIGNED_IN')
  }

  getActivityEventTone(event: SecurityTimelineEvent): string {
    if (event.eventType === 'mfa_preference_updated') return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
    if (event.eventType === 'mfa_disabled') return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
    if (event.eventType === 'logout') return 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200'
    if (event.eventType === 'revoke') return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
    return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
  }

  formatActivityTimestamp(event: SecurityTimelineEvent): string {
    return event.occurredAt ? event.occurredAt.toLocaleString() : this.translate.instant('SETTINGS_SECURITY.UNKNOWN_TIME')
  }

  getActivitySummary(event: SecurityTimelineEvent): string {
    const location = event.locationLabel || this.translate.instant('SETTINGS_SECURITY.UNKNOWN_LOCATION')
    return `${event.browserLabel} • ${event.osLabel} • ${location}`
  }

  isCurrentActivityEvent(event: SecurityTimelineEvent): boolean {
    return !!event.sessionId && event.sessionId === this.currentSessionId()
  }

  private getEventBrowser(event: loginHistoryEvent): string {
    const explicit = String(event.browser || '').trim()
    if (explicit && explicit.toLowerCase() !== 'unknown') {
      return explicit
    }

    return this.detectBrowserFromUserAgent(event.userAgent || '')
  }

  private getEventOS(event: loginHistoryEvent): string {
    const explicit = String(event.os || '').trim()
    if (explicit && explicit.toLowerCase() !== 'unknown') {
      return explicit
    }

    return this.detectOsFromUserAgent(event.userAgent || '')
  }

  initProviders() {
    const providersData = this.user?.providerData
      .map((provider) => this.toUiProviderKey(provider.providerId))
      .filter((provider): provider is string => !!provider)

    // Connected Providers section only supports unlinking SSO providers here.
    this.remProviders = providersData?.filter((provider) => provider === 'google' || provider === 'github') ?? []
    this.loginProviders = ['google', 'github'].filter(p => !this.remProviders.includes(p))
  }

  private toFirebaseProviderId(provider: string): string {
    if (provider === 'password') return 'password'
    if (provider === 'phone') return 'phone'
    return `${provider}.com`
  }

  private toUiProviderKey(providerId: string): string | null {
    if (!providerId) return null
    if (providerId === 'password' || providerId === 'phone') return providerId
    return providerId.endsWith('.com') ? providerId.replace('.com', '') : providerId
  }

  private getCurrentProviderId(): string {
    return this.user?.currProviderData?.providerId || this.user?.providerId || ''
  }

  isCurrentProvider(provider: string): boolean {
    return this.getCurrentProviderId() === this.toFirebaseProviderId(provider)
  }

  private async refreshSecurityUser(): Promise<void> {
    const newUser = await this.authService.refreshUserData()
    if (newUser) {
      this.user = newUser
      this.hasProviderPassword.set({
        provider: this.getCurrentProviderId(),
        has: this.user?.providerData.some((provider) => provider.providerId === 'password') ?? false,
      })
      this.initProviders()
      this.syncTotpFactors()
      this.syncMfaStatusControl()
      this.loadActiveSessions()
      this.loadActivityTimeline()
    }
  }

  hasAnyMfaFactors(): boolean {
    return this.totpFactors().length > 0 || this.phoneMfaFactors().length > 0
  }

  private syncMfaStatusControl(): void {
    this.mfaStatusControl.setValue(this.hasAnyMfaFactors(), { emitEvent: false })
  }

  private canEnrollPhoneMfa(): boolean {
    return this.canEnrollTotp()
  }

  getExistingPhoneMfaNumber(): string {
    const phoneFactor = this.phoneMfaFactors()[0] as MultiFactorInfo & { phoneNumber?: string }
    return String(phoneFactor?.phoneNumber || '').trim()
  }

  private getPhoneNumberCandidate(): string {
    return this.getExistingPhoneMfaNumber() || String(this.user?.phoneNumber || '').trim()
  }

  private async onMfaStatusSelected(enabled: boolean): Promise<void> {
    if (enabled) {
      if (this.hasAnyMfaFactors()) {
        this.syncMfaStatusControl()
        return
      }

      if (!this.canEnrollPhoneMfa()) {
        this.syncMfaStatusControl()
        this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.MFA_UNAVAILABLE_SIGNIN_METHOD'), SnackBarType.warning, '', 6000)
        return
      }

      if (this.user?.emailVerified) {
        // Prefer SMS if user already has a verified phone (linked phone provider or phoneVerified flag)
        if (this.isPhoneVerifiedForDisplay()) {
          this.openPhoneAdd()
          return
        }
        await this.startTotpSetup()
        return
      }

      this.openPhoneAdd()
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.MFA_ADD_SMS_FIRST'), SnackBarType.info, '', 6000)
      return
    }

    if (!this.hasAnyMfaFactors()) {
      this.syncMfaStatusControl()
      return
    }

    this.confirmationDialog.set('disable-mfa')
    this.cdr.detectChanges()
    return

  }

  closeConfirmationDialog(): void {
    const dialogType = this.confirmationDialog()
    this.confirmationDialog.set(null)
    this.pendingSessionToRevoke.set(null)
    this.pendingTotpFactorToRemove.set(null)

    if (dialogType === 'disable-mfa') {
      this.syncMfaStatusControl()
    }

    this.cdr.detectChanges()
  }

  async confirmDialogAction(): Promise<void> {
    const dialogType = this.confirmationDialog()
    this.confirmationDialog.set(null)

    if (dialogType === 'disable-mfa') {
      await this.disableMfaFactors()
      return
    }

    if (dialogType === 'disable-totp-factor') {
      const factor = this.pendingTotpFactorToRemove()
      this.pendingTotpFactorToRemove.set(null)
      if (factor?.uid) {
        await this.removeTotpFactor(factor.uid)
      }
      return
    }

    if (dialogType === 'revoke-current-session') {
      const session = this.pendingSessionToRevoke()
      this.pendingSessionToRevoke.set(null)
      if (session) {
        this.runSessionRevoke(session)
      }
      return
    }

    this.pendingSessionToRevoke.set(null)
    this.cdr.detectChanges()
  }

  getConfirmationTitle(): string {
    if (this.confirmationDialog() === 'disable-mfa') {
      return this.translate.instant('SETTINGS_SECURITY.CONFIRM_DISABLE_MFA_TITLE')
    }

    if (this.confirmationDialog() === 'disable-totp-factor') {
      return this.translate.instant('SETTINGS_SECURITY.CONFIRM_DISABLE_TOTP_TITLE')
    }

    if (this.confirmationDialog() === 'revoke-current-session') {
      return this.translate.instant('SETTINGS_SECURITY.CONFIRM_REVOKE_SESSION_TITLE')
    }

    return this.translate.instant('SETTINGS_SECURITY.CONFIRM_DEFAULT_TITLE')
  }

  getConfirmationSubtitle(): string {
    if (this.confirmationDialog() === 'disable-mfa') {
      return this.translate.instant('SETTINGS_SECURITY.CONFIRM_DISABLE_MFA_SUB')
    }

    if (this.confirmationDialog() === 'disable-totp-factor') {
      const factor = this.pendingTotpFactorToRemove()
      const factorName = factor?.displayName || this.translate.instant('SETTINGS_SECURITY.AUTH_APP_NAME')
      return this.translate.instant('SETTINGS_SECURITY.CONFIRM_DISABLE_TOTP_SUB_A') + factorName + this.translate.instant('SETTINGS_SECURITY.CONFIRM_DISABLE_TOTP_SUB_B')
    }

    if (this.confirmationDialog() === 'revoke-current-session') {
      return this.translate.instant('SETTINGS_SECURITY.CONFIRM_REVOKE_SESSION_SUB')
    }

    return ''
  }

  getConfirmationConfirmLabel(): string {
    if (this.confirmationDialog() === 'disable-mfa') {
      return this.translate.instant('SETTINGS_SECURITY.CONFIRM_DISABLE_MFA_BTN')
    }

    if (this.confirmationDialog() === 'disable-totp-factor') {
      return this.translate.instant('SETTINGS_SECURITY.CONFIRM_DISABLE_TOTP_BTN')
    }

    if (this.confirmationDialog() === 'revoke-current-session') {
      return this.translate.instant('SETTINGS_SECURITY.CONFIRM_REVOKE_SESSION_BTN')
    }

    return this.translate.instant('SETTINGS_SECURITY.CONFIRM_DEFAULT_BTN')
  }

  private openCurrentSessionRevokeDialog(session: SessionDisplayInfo & { id?: string }): void {
    this.pendingSessionToRevoke.set(session)
    this.confirmationDialog.set('revoke-current-session')
    this.cdr.detectChanges()
  }

  private async disableMfaFactors(): Promise<void> {

    this.loading.mfa = true
    this.totpError.set('')
    this.phoneError.set('')
    this.cdr.detectChanges()

    try {
      const factorsToRemove = [...this.totpFactors(), ...this.phoneMfaFactors()]
      for (const factor of factorsToRemove) {
        await this.authService.unenrollMultiFactor(factor.uid)
      }

      this.pendingTotpSecret = null
      this.totpStep.set('idle')
      this.phoneStep.set('idle')
      this.phoneMfaVerificationId = ''
      await this.refreshSecurityUser()
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.TWO_FACTOR_DISABLED'), SnackBarType.success, '', 3000)
      try {
        await this.authService.notifyMfaDisabledRisk()
      } catch {
        // Best-effort security notification.
      }
    } catch (error: any) {
      const message = this.getMfaErrorMessage(error)
      this.showSnackbar(message, SnackBarType.error, '', 6000)
      this.syncMfaStatusControl()
    } finally {
      this.loading.mfa = false
      this.cdr.detectChanges()
    }
  }

  // PHASE 2.2: Updated runSessionRevoke to work with SessionDisplayInfo
  private runSessionRevoke(session: SessionDisplayInfo & { id?: string }): void {
    const loginId = resolveSessionIdFromRecord(session)
    if (!loginId || this.revokingSessionId()) return

    this.revokingSessionId.set(loginId)
    this.sessionsError.set('')
    this.cdr.detectChanges()

    this.firestoreService.revokeMyLoginSession(loginId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.SESSION_REVOKED'), SnackBarType.success, '', 3000)
          // The one account-takeover remedy a user can reach on their own. Counted per
          // session so "how often does someone revoke a session" has an answer.
          this.analytics.trackEvent('session_revoked', { sessionId: loginId, current: loginId === this.currentSessionId() })
            .subscribe({ error: () => undefined })
          if (loginId === this.currentSessionId()) {
            this.authService.logout().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
              complete: () => {
                this.revokingSessionId.set('')
                this.cdr.detectChanges()
              }
            })
            return
          }

          this.revokingSessionId.set('')
          this.loadActiveSessions()
          this.loadActivityTimeline()
          this.cdr.detectChanges()
        },
        error: (error) => {
          this.revokingSessionId.set('')
          this.sessionsError.set(getErrorMessage(error, this.translate))
          this.cdr.detectChanges()
        }
      })
  }


  linkLoginProvider(provider: string) {
    if (this.isProviderMutationInProgress()) {
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.PROVIDER_OP_IN_PROGRESS'), SnackBarType.info, '', 3000)
      return
    }

    console.log('linkLoginProvider', provider)

    switch (provider) {
      case 'google':
        this.linkWithGoogle()
        break
      case 'github':
        this.linkWithGitHub()
        break
      default:
        break
    }

  }

  private isProviderMutationInProgress(): boolean {
    return this.loading.google || this.loading.github || this.loading.remove || this.isMfaLinkLoading()
  }

  private linkWithGoogle() {
    this.loading.google = true;
    const expectedUid = this.user?.uid || ''
    const provider = new GoogleAuthProvider()
    provider.addScope("email")
    provider.addScope("profile")
    provider.addScope("openid")

    provider.setCustomParameters({ prompt: 'select_account' })
    from(this.authService.linkProvider(provider))

      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(
        {
          next: async (response) => {

            if (response && response.user) {
              if (expectedUid && response.user.uid !== expectedUid) {
                this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.LINK_BLOCKED_GOOGLE'), SnackBarType.error, '', 7000)
                return
              }
              // this.pendingCredential = GoogleAuthProvider.credentialFromResult(response.result);
              // If there's a pending credential from a previous social login attempt, link it now
              // const userCredential =  await this.handlePendingCredentialLinking(response.user)
              // response.user = userCredential?.user || response.user
              if (response.user.displayName || response.user.photoURL) {
                await updateProfile(response.user, {
                  displayName: response.user.displayName,
                  photoURL: response.user.photoURL ? response.user.photoURL : DEFAULT_PROFILE_URL,

                })
              }
              await this.firestoreService.storeUserData(response.user, this.user?.providerId || 'google.com', true, this.user?.username)
              await this.refreshSecurityUser()
              this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.LINKED_GOOGLE'), SnackBarType.success, '', 3000)
              this.cdr.detectChanges()
            }
          },
          error: (error) => {
            // this.extractFirebaseError(error)
            // this.handleAccountExistsError(error, 'google.com')
            if (error?.code === 'auth/multi-factor-auth-required') {
              void this.handleMfaLinkChallenge(error, 'google')
              return
            }
            const errorMessage = getErrorMessage(error, this.translate)
            this.showSnackbar(errorMessage, SnackBarType.error, '', 5000)
            this.loading.google = false
            this.cdr.detectChanges()
          },
          complete: () => {
            this.loading.google = false
            this.cdr.detectChanges()
          }
        }
      )
  }

  private linkWithGitHub() {
    this.loading.github = true;
    const expectedUid = this.user?.uid || ''

    const provider = new GithubAuthProvider();
    provider.addScope('user:email')
    provider.addScope('read:user')
    provider.setCustomParameters({ prompt: 'select_account' })


    from(this.authService.linkProvider(provider))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(
        {
          next: async (response) => {

            if (response && response.user) {
              if (expectedUid && response.user.uid !== expectedUid) {
                this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.LINK_BLOCKED_GITHUB'), SnackBarType.error, '', 7000)
                return
              }
              // this.pendingCredential = GithubAuthProvider.credentialFromResult(response.result);
              // If there's a pending credential from a previous social login attempt, link it now
              // const userCredential =  await this.handlePendingCredentialLinking(response.user)
              // response.user = userCredential?.user || response.user

              if (response.user.displayName || response.user.photoURL) {
                await updateProfile(response.user, {
                  displayName: response.user.displayName,
                  photoURL: response.user.photoURL ? response.user.photoURL : DEFAULT_PROFILE_URL,
                })
              }
              await this.firestoreService.storeUserData(response.user, this.user?.providerId || 'github.com', true, this.user?.username)
              await this.refreshSecurityUser()
              this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.LINKED_GITHUB'), SnackBarType.success, '', 3000)
              this.cdr.detectChanges()
            }
          },
          error: (error) => {
            // this.extractFirebaseError(error)
            // this.handleAccountExistsError(error, 'github.com')
            if (error?.code === 'auth/multi-factor-auth-required') {
              void this.handleMfaLinkChallenge(error, 'github')
              return
            }
            const errorMessage = getErrorMessage(error, this.translate)
            this.showSnackbar(errorMessage, SnackBarType.error, '', 5000)
            this.loading.github = false
            this.cdr.detectChanges()
          },
          complete: () => {
            this.loading.github = false
            this.cdr.detectChanges()
          }
        }

      )
  }

  protected async disconnectProvider(provider: string) {
    if (this.isProviderMutationInProgress()) {
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.PROVIDER_OP_IN_PROGRESS'), SnackBarType.info, '', 3000)
      return
    }

    // Check if the provider to be unlinked is the currently logged-in provider
    const providerId = this.toFirebaseProviderId(provider)
    if (this.isCurrentProvider(provider)) {
      this.showSnackbar(
        `Cannot unlink the currently logged-in provider (${provider}).`,
        SnackBarType.error
      )
      return
    }

    const verified = await this.highRiskActionService.ensureVerified('unlink_provider')
    if (!verified) {
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.UNLINK_DEVICE_VERIFY_REQUIRED'), SnackBarType.warning, '', 4000)
      return
    }

    if (provider !== 'password')
      this.loading[provider as 'github' | 'google'] = true
    else
      this.loading.email = (provider === 'password')

    from(this.authService.unlinkProvider(providerId))
      .pipe(
        takeUntilDestroyed(this.destroyRef) // Automatically unsubscribe when the component is destroyed
      )
      .subscribe({
        next: async () => {
          await this.refreshSecurityUser()
          this.cdr.detectChanges()
        },
        error: (error) => {
          if (provider !== 'password')
            this.loading[provider as 'github' | 'google'] = false
          else
            this.loading.email = !(provider === 'password')

          // Handle errors and show an error message
          const explicitMessage = typeof error?.message === 'string' ? error.message.trim() : ''
          const errorMessage = explicitMessage || getErrorMessage(error, this.translate);
          this.showSnackbar(errorMessage, SnackBarType.error, '', 5000);
          this.cdr.detectChanges()
        },
        complete: () => {
          if (provider !== 'password')
            this.loading[provider as 'github' | 'google' ] = false
          else
            this.loading.email = !(provider === 'password')
          this.showSnackbar(`${provider} provider disconnected`, SnackBarType.success, '', 3000);
          this.cdr.detectChanges()
        }
      })
  }

  setPassword() {

    const newPassword = this.password?.value
    if (!newPassword) {
      // this.securityForm.markAllAsTouched()
      // this.cdr.detectChanges()
      return
    }
    this.loading.password = true
    from(this.authService.updatePassword(newPassword))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: async (userCredential) => {

          try {
                await this.refreshSecurityUser()
          }
          catch (error) {
            console.error('Error updating user data after password change:', error)
          }
          
         
          this.password?.reset() 
          this.cdr.detectChanges()
        },
        error: (error) => {
          const errorMessage = getErrorMessage(error, this.translate)
          this.showSnackbar(errorMessage, SnackBarType.error, '', 5000)
          this.loading.password = false
          this.cdr.detectChanges()
        },
        complete: () => {
          this.loading.password = false
          this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.PASSWORD_CHANGED'), SnackBarType.success, '', 3000)
          this.cdr.detectChanges()
        }
      })
  }

  onSubmit() {

  }

  async startTotpSetup(): Promise<void> {
    if (this.loading.mfa) return

    this.loading.mfa = true
    this.totpError.set('')
    this.cdr.detectChanges()

    try {
      const enrollment = await this.authService.startTotpEnrollment()
      const qrCodeDataUrl = this.createTotpQrCodeDataUrl(enrollment.qrCodeUrl)
      this.pendingTotpSecret = enrollment.secret
      this.totpSecretKey.set(enrollment.secretKey)
      this.totpQrUrl.set(enrollment.qrCodeUrl)
      this.totpQrCodeDataUrl.set(qrCodeDataUrl)
      this.totpCode.reset('')
      this.totpStep.set('verify')
    } catch (error: any) {
      const message = this.getMfaErrorMessage(error)
      this.totpError.set(message)
      this.showSnackbar(message, SnackBarType.warning, '', 6000)
    } finally {
      this.loading.mfa = false
      this.cdr.detectChanges()
    }
  }

  async completeTotpSetup(): Promise<void> {
    if (!this.pendingTotpSecret || this.totpCode.invalid || this.loading.mfa) return

    this.loading.mfa = true
    this.totpError.set('')
    this.cdr.detectChanges()

    try {
      await this.authService.completeTotpEnrollment(
        this.pendingTotpSecret,
        this.totpCode.value,
        this.totpDisplayName.value
      )
      this.pendingTotpSecret = null
      this.totpStep.set('idle')
      this.totpCode.reset('')
      this.totpSecretKey.set('')
      this.totpQrUrl.set('')
      this.totpQrCodeDataUrl.set('')
      this.syncTotpFactors()
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.TOTP_ENROLLED'), SnackBarType.success, '', 3000)
    } catch (error: any) {
      const message = this.getMfaErrorMessage(error)
      this.totpError.set(message)
      this.showSnackbar(message, SnackBarType.warning, '', 6000)
    } finally {
      this.loading.mfa = false
      this.cdr.detectChanges()
    }
  }

  cancelTotpSetup(): void {
    this.pendingTotpSecret = null
    this.totpStep.set('idle')
    this.totpError.set('')
    this.totpCode.reset('')
    this.totpSecretKey.set('')
    this.totpQrUrl.set('')
    this.totpQrCodeDataUrl.set('')
    this.cdr.detectChanges()
  }

  openTotpDisableDialog(factor: MultiFactorInfo): void {
    this.pendingTotpFactorToRemove.set(factor)
    this.confirmationDialog.set('disable-totp-factor')
    this.cdr.detectChanges()
  }

  async removeTotpFactor(factorUid: string): Promise<void> {
    if (this.loading.mfa) return

    this.loading.mfa = true
    this.totpError.set('')
    this.cdr.detectChanges()

    try {
      await this.authService.unenrollMultiFactor(factorUid)
      this.syncTotpFactors()
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.TOTP_REMOVED'), SnackBarType.success, '', 3000)
    } catch (error: any) {
      const message = this.getMfaErrorMessage(error)
      this.totpError.set(message)
      this.showSnackbar(message, SnackBarType.warning, '', 6000)
    } finally {
      this.loading.mfa = false
      this.cdr.detectChanges()
    }
  }

  private getMfaErrorMessage(error: any): string {
    const code = String(error?.code || '').toLowerCase()
    const rawMessage = String(error?.message || '').trim()
    const normalizedMessage = rawMessage.toLowerCase()

    if (
      code === 'auth/missing-phone-number' ||
      code === 'auth/invalid-argument' ||
      normalizedMessage.includes('no phone number enrolled') ||
      normalizedMessage.includes('missing phone number') ||
      normalizedMessage.includes('missing phoneenrollmentinfo') ||
      normalizedMessage.includes('phoneenrollmentinfo')
    ) {
      return this.translate.instant('SETTINGS_SECURITY.MFA_ERR_SMS_REAL_FACTOR')
    }

    if (
      code === 'auth/unsupported-first-factor' ||
      normalizedMessage.includes('unsupported_first_factor') ||
      normalizedMessage.includes('mfa is not available for the given first factor')
    ) {
      return this.translate.instant('SETTINGS_SECURITY.MFA_ERR_UNSUPPORTED_FIRST')
    }

    if (
      normalizedMessage.includes('operation_not_allowed') &&
      normalizedMessage.includes('totp based mfa not enabled')
    ) {
      return this.translate.instant('SETTINGS_SECURITY.MFA_ERR_TOTP_NOT_ENABLED')
    }

    if (rawMessage && !code.startsWith('auth/')) {
      return rawMessage
    }

    return getErrorMessage(error, this.translate)
  }

  isPhoneVerifiedForDisplay(): boolean {
    const hasPhoneProvider = this.user?.providerData?.some((provider) => provider.providerId === 'phone') ?? false
    return this.user?.phoneVerified === true || (hasPhoneProvider && !!this.user?.phoneNumber) || this.phoneMfaFactors().length > 0
  }

  canEnrollTotp(): boolean {
    const unsupportedFirstFactors = new Set(['phone', 'anonymous', 'gc.apple.com'])
    const providers = this.user?.providerData || []
    if (!providers.length) {
      return false
    }

    return providers.some((provider) => !unsupportedFirstFactors.has(provider.providerId))
  }

  async copyTotpValue(value: string, label: string): Promise<void> {
    const normalizedValue = value.trim()
    if (!normalizedValue) {
      return
    }

    if (!isPlatformBrowser(this.platformId) || !navigator?.clipboard?.writeText) {
      this.showSnackbar(`Copy ${label.toLowerCase()} manually`, SnackBarType.info, '', 3000)
      return
    }

    try {
      await navigator.clipboard.writeText(normalizedValue)
      this.showSnackbar(`${label} copied`, SnackBarType.success, '', 2500)
    } catch {
      this.showSnackbar(`Failed to copy ${label.toLowerCase()}`, SnackBarType.warning, '', 3000)
    }
  }

  private createTotpQrCodeDataUrl(value: string): string {
    const qrCode = qrcodeGenerator(0, 'M')
    qrCode.addData(value)
    qrCode.make()

    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrCode.createSvgTag({
      cellSize: 6,
      margin: 1,
      scalable: true,
    }))}`
  }

  private syncTotpFactors(): void {
    const factors = this.authService.getEnrolledMultiFactorHints()
    this.totpFactors.set(factors.filter((factor) => factor.factorId === 'totp'))
    this.phoneMfaFactors.set(factors.filter((factor) => factor.factorId === 'phone'))
    this.syncMfaStatusControl()
  }


  darkMode() {

    return this.themeDarkMode ? '_dark' : ''

  }


  protected checkPasswordStrength(password: string): string {
      return checkPasswordStrength(password, (k) => this.translate.instant(k))
  }

  getErrorLabel(controlName: string): string | undefined {
      return getErrorLabel(this.securityForm, controlName)
    }
  


  // 'info' | 'success' | 'warning' | 'error'
  private showSnackbar(
    message: string,
    type: SnackBarType = SnackBarType.info,
    action: string | '' = '',
    duration: number = 3000) {

    this.snackbarService.showSnackbar(message, type, action, duration)
  }

  ngAfterViewInit(): void {
    if (!isPlatformBrowser(this.platformId)) return
    this.initRecaptcha()
  }

  private initRecaptcha(): void {
    const el = this.document.getElementById('recaptcha-security')
    if (!el) return
    this.recaptchaVerifier = new RecaptchaVerifier(this.fireAuth, 'recaptcha-security', { size: 'invisible' })
    this.recaptchaVerifier.render()
  }

  openPhoneAdd(): void {
    this.phoneStep.set('enter-number')
    this.phoneError.set('')
    this.phoneNumber.reset(this.getPhoneNumberCandidate())
    this.otpControl.reset('')
    this.phoneMfaVerificationId = ''
    this.cdr.detectChanges()
  }

  openAccountPhoneEdit(): void {
    this.accountPhoneStep.set('enter-number')
    this.accountPhoneError.set('')
    this.accountPhoneNumber.reset(String(this.user?.phoneNumber || '').trim())
    this.accountPhoneCode.reset('')
    this.accountPhoneConfirmationResult = null
    this.cdr.detectChanges()
  }

  async sendAccountPhoneCode(): Promise<void> {
    if (this.accountPhoneNumber.invalid || this.loading.phone) return

    const existingAccountPhone = String(this.user?.phoneNumber || '').trim()
    const nextPhone = String(this.accountPhoneNumber.value || '').trim()
    if (existingAccountPhone && existingAccountPhone !== nextPhone) {
      this.accountPhoneError.set(this.translate.instant('SETTINGS_SECURITY.ERR_UNLINK_CURRENT_PHONE_FIRST'))
      this.cdr.detectChanges()
      return
    }

    this.loading.phone = true
    this.accountPhoneError.set('')
    this.cdr.detectChanges()

    try {
      this.accountPhoneConfirmationResult = await this.authService.linkPhoneNumber(this.accountPhoneNumber.value, this.recaptchaVerifier)
      this.accountPhoneStep.set('enter-code')
      this.accountPhoneCode.reset('')
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.CODE_SENT_ACCOUNT_PHONE'), SnackBarType.info, '', 3000)
    } catch (error: any) {
      this.accountPhoneError.set(getErrorMessage(error, this.translate))
      try { this.recaptchaVerifier.clear() } catch { /* ignore */ }
      this.initRecaptcha()
    } finally {
      this.loading.phone = false
      this.cdr.detectChanges()
    }
  }

  async verifyAccountPhoneCode(): Promise<void> {
    if (this.accountPhoneCode.invalid || !this.accountPhoneConfirmationResult || this.loading.code) return
    this.loading.code = true
    this.accountPhoneError.set('')
    this.cdr.detectChanges()

    try {
      const result = await this.authService.completePhoneVerification(
        this.accountPhoneConfirmationResult,
        this.accountPhoneCode.value
      )

      const linkedPhone = String(result.user.phoneNumber || this.accountPhoneNumber.value || '').trim()
      if (result.user?.uid && linkedPhone) {
        await this.firestoreService.updateUserPhoneNumber(result.user.uid, linkedPhone, true)
      }

      await this.refreshSecurityUser()
      this.accountPhoneStep.set('idle')
      this.accountPhoneConfirmationResult = null
      this.accountPhoneCode.reset('')
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.ACCOUNT_PHONE_VERIFIED'), SnackBarType.success, '', 3000)
    } catch (error: any) {
      this.accountPhoneError.set(getErrorMessage(error, this.translate))
      this.accountPhoneCode.reset('')
    } finally {
      this.loading.code = false
      this.cdr.detectChanges()
    }
  }

  cancelAccountPhoneEdit(): void {
    this.accountPhoneStep.set('idle')
    this.accountPhoneError.set('')
    this.accountPhoneNumber.reset('')
    this.accountPhoneCode.reset('')
    this.accountPhoneConfirmationResult = null
    this.cdr.detectChanges()
  }

  async unlinkAccountPhone(): Promise<void> {
    if (!this.user?.uid) return
    if (this.isCurrentProvider('phone')) {
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.ERR_UNLINK_ACTIVE_PHONE'), SnackBarType.error, '', 5000)
      return
    }

    const verified = await this.highRiskActionService.ensureVerified('unlink_provider')
    if (!verified) {
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.UNLINK_DEVICE_VERIFY_REQUIRED'), SnackBarType.warning, '', 4000)
      return
    }

    this.loading.remove = true
    this.accountPhoneError.set('')
    this.cdr.detectChanges()

    try {
      await this.authService.unlinkProvider('phone')
      await this.firestoreService.updateUserPhoneNumber(this.user.uid, '', false)
      await firstValueFrom(this.authService.updatePhoneVerificationStatus(this.user.uid, false))
      await this.refreshSecurityUser()
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.ACCOUNT_PHONE_UNLINKED'), SnackBarType.success, '', 3000)
    } catch (error: any) {
      this.accountPhoneError.set(getErrorMessage(error, this.translate))
      this.showSnackbar(this.accountPhoneError(), SnackBarType.error, '', 5000)
    } finally {
      this.loading.remove = false
      this.cdr.detectChanges()
    }
  }

  async sendPhoneCode(): Promise<void> {
    if (this.phoneNumber.invalid || this.loading.phone) return
    this.loading.phone = true
    this.phoneError.set('')
    this.cdr.detectChanges()
    try {
      this.phoneMfaVerificationId = await this.authService.startPhoneMfaEnrollment(
        this.phoneNumber.value, this.recaptchaVerifier
      )
      this.phoneStep.set('enter-code')
      this.otpControl.reset('')
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.CODE_SENT_PHONE'), SnackBarType.info, '', 3000)
    } catch (error: any) {
      this.phoneError.set(this.getMfaErrorMessage(error))
      try { this.recaptchaVerifier.clear() } catch { /* ignore */ }
      this.initRecaptcha()
    } finally {
      this.loading.phone = false
      this.cdr.detectChanges()
    }
  }

  async verifyPhoneOtp(code: string): Promise<void> {
    if (!code || code.length < 6 || !this.phoneMfaVerificationId || this.loading.code) return
    this.loading.code = true
    this.phoneError.set('')
    this.cdr.detectChanges()
    try {
      await this.authService.completePhoneMfaEnrollment(this.phoneMfaVerificationId, code)
      await this.refreshSecurityUser()
      this.phoneStep.set('idle')
      this.phoneMfaVerificationId = ''
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.SMS_FACTOR_ENROLLED'), SnackBarType.success, '', 3000)
    } catch (error: any) {
      this.phoneError.set(this.getMfaErrorMessage(error))
      this.otpControl.reset('')
    } finally {
      this.loading.code = false
      this.cdr.detectChanges()
    }
  }

  cancelPhoneVerification(): void {
    this.phoneStep.set('idle')
    this.phoneError.set('')
    this.phoneNumber.reset('')
    this.otpControl.reset('')
    this.phoneMfaVerificationId = ''
    this.cdr.detectChanges()
  }

  async removePhoneNumber(): Promise<void> {
    this.loading.remove = true
    this.cdr.detectChanges()
    try {
      for (const factor of this.phoneMfaFactors()) {
        await this.authService.unenrollMultiFactor(factor.uid)
      }
      await this.refreshSecurityUser()
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.SMS_FACTOR_REMOVED'), SnackBarType.success, '', 3000)
    } catch (error: any) {
      this.showSnackbar(this.getMfaErrorMessage(error), SnackBarType.error, '', 5000)
    } finally {
      this.loading.remove = false
      this.cdr.detectChanges()
    }
  }

  async removePhoneMfaFactor(factorUid: string): Promise<void> {
    if (this.loading.remove) return
    this.loading.remove = true
    this.phoneError.set('')
    this.cdr.detectChanges()

    try {
      await this.authService.unenrollMultiFactor(factorUid)
      await this.refreshSecurityUser()
      this.showSnackbar(this.translate.instant('SETTINGS_SECURITY.SMS_FACTOR_REMOVED'), SnackBarType.success, '', 3000)
    } catch (error: any) {
      this.phoneError.set(this.getMfaErrorMessage(error))
      this.showSnackbar(this.phoneError(), SnackBarType.error, '', 5000)
    } finally {
      this.loading.remove = false
      this.cdr.detectChanges()
    }
  }

  // ── MFA challenge for provider linking ────────────────────────────────────

  private async handleMfaLinkChallenge(error: any, provider: 'google' | 'github'): Promise<void> {
    const resolver = this.authService.getMfaResolverFromError(error)
    if (!resolver) {
      const errorMessage = getErrorMessage(error, this.translate)
      this.showSnackbar(errorMessage, SnackBarType.error, '', 5000)
      this.loading[provider] = false
      this.cdr.detectChanges()
      return
    }

    this.mfaLinkResolver.set(resolver)
    this.mfaLinkProvider.set(provider)
    this.mfaLinkError.set('')
    this.mfaLinkPhoneFactorIndex.set(0) // Reset phone factor index
    this.mfaLinkPhoneFactorAttempts.set([]) // Clear attempts
    this.mfaLinkOtp.reset('')
    this.mfaLinkTotpCode.reset('')

    const phoneFactors = resolver.hints.filter(h => h.factorId === 'phone')
    const totpFactor = resolver.hints.find(h => h.factorId === 'totp')
    const preferredMethod = this.getPreferredMfaMethod()

    if (totpFactor && (preferredMethod === 'totp' || phoneFactors.length === 0)) {
      this.mfaLinkStep.set('totp-code')
      this.loading[provider] = false
      this.cdr.detectChanges()
      return
    }

    if (phoneFactors.length > 0) {
      this.loading[provider] = true
      this.cdr.detectChanges()
      await this.tryMfaPhoneLinkWithFallback(resolver, phoneFactors, provider)
    } else if (totpFactor) {
      this.mfaLinkStep.set('totp-code')
      this.loading[provider] = false
    } else {
      const errorMessage = getErrorMessage(error, this.translate)
      this.showSnackbar(errorMessage, SnackBarType.error, '', 5000)
      this.loading[provider] = false
    }

    this.cdr.detectChanges()
  }

  private async tryMfaPhoneLinkWithFallback(resolver: MultiFactorResolver, phoneFactors: any[], provider: 'google' | 'github'): Promise<void> {
    const attempts: {factorUid: string, phoneNumber: string, error: string}[] = []

    for (let i = 0; i < phoneFactors.length; i++) {
      const phoneFactor = phoneFactors[i]
      const phoneInfo = phoneFactor as MultiFactorInfo & { phoneNumber?: string }
      const phoneNumber = phoneInfo.phoneNumber || phoneFactor.displayName || 'your phone'
      const priority = i === 0 ? 'primary' : i === 1 ? 'secondary' : 'tertiary'

      try {
        this.mfaLinkPhoneFactorIndex.set(i)
        this.mfaLinkPhoneHint.set(`${phoneNumber} (${priority})`)
        this.cdr.detectChanges()

        const verificationId = await this.authService.startPhoneMfaChallenge(
          resolver, phoneFactor.uid, this.recaptchaVerifier
        )
        this.mfaLinkVerificationId.set(verificationId)
        this.mfaLinkStep.set('phone-code')
        this.loading[provider] = false
        this.cdr.detectChanges()
        return // Success, exit the loop
      } catch (err: any) {
        const errorMsg = this.getMfaErrorMessage(err)
        attempts.push({
          factorUid: phoneFactor.uid,
          phoneNumber: phoneNumber,
          error: errorMsg
        })

        // If this isn't the last attempt, try the next phone
        if (i < phoneFactors.length - 1) {
          try { this.recaptchaVerifier.clear() } catch { /* ignore */ }
          this.initRecaptcha()
          continue // Try next phone
        }
      }
    }

    // All phone factors failed
    this.mfaLinkPhoneFactorAttempts.set(attempts)
    const attemptsDisplay = attempts.map((a, idx) => `${idx + 1}. ${a.phoneNumber}: ${a.error}`).join('\n')
    this.mfaLinkError.set(this.translate.instant('SETTINGS_SECURITY.ERR_SEND_CODE_ALL_PHONES') + '\n' + attemptsDisplay)
    this.mfaLinkStep.set('idle')
    this.mfaLinkResolver.set(null)
    try { this.recaptchaVerifier.clear() } catch { /* ignore */ }
    this.initRecaptcha()
    this.loading[provider] = false
    this.cdr.detectChanges()
  }

  async completeMfaLinkPhoneChallenge(): Promise<void> {
    const code = this.mfaLinkOtp.value
    const resolver = this.mfaLinkResolver()
    const verificationId = this.mfaLinkVerificationId()
    const provider = this.mfaLinkProvider()
    if (!code || code.length < 6 || !verificationId || !resolver || !provider) return

    this.loading[provider] = true
    this.mfaLinkError.set('')
    this.cdr.detectChanges()

    try {
      const userCredential = await this.authService.completeMfaPhoneChallenge(resolver, verificationId, code)
      await this.finishMfaLinkCompletion(userCredential, provider)
    } catch (err: any) {
      this.mfaLinkError.set(this.getMfaErrorMessage(err))
      this.mfaLinkOtp.reset('')
    } finally {
      this.loading[provider] = false
      this.cdr.detectChanges()
    }
  }

  async completeMfaLinkTotpChallenge(): Promise<void> {
    const code = this.mfaLinkTotpCode.value
    const resolver = this.mfaLinkResolver()
    const provider = this.mfaLinkProvider()
    if (!code || this.mfaLinkTotpCode.invalid || !resolver || !provider) return

    this.loading[provider] = true
    this.mfaLinkError.set('')
    this.cdr.detectChanges()

    try {
      const totpHint = resolver.hints.find(h => h.factorId === 'totp')
      if (!totpHint) throw new Error(this.translate.instant('SETTINGS_SECURITY.ERR_MFA_NO_TOTP_FACTOR'))
      const userCredential = await this.authService.completeMfaTotpChallenge(resolver, totpHint.uid, code)
      await this.finishMfaLinkCompletion(userCredential, provider)
    } catch (err: any) {
      this.mfaLinkError.set(this.getMfaErrorMessage(err))
      this.mfaLinkTotpCode.reset('')
    } finally {
      this.loading[provider] = false
      this.cdr.detectChanges()
    }
  }

  private async finishMfaLinkCompletion(userCredential: UserCredential, provider: 'google' | 'github'): Promise<void> {
    if (userCredential?.user) {
      const expectedUid = this.user?.uid || ''
      if (expectedUid && userCredential.user.uid !== expectedUid) {
        throw new Error(this.translate.instant('SETTINGS_SECURITY.ERR_MFA_LINK_DIFFERENT_USER'))
      }
      if (userCredential.user.displayName || userCredential.user.photoURL) {
        await updateProfile(userCredential.user, {
          displayName: userCredential.user.displayName,
          photoURL: userCredential.user.photoURL || DEFAULT_PROFILE_URL,
        })
      }
      await this.firestoreService.storeUserData(
        userCredential.user,
        this.user?.providerId || `${provider}.com`,
        true,
        this.user?.username
      )
    }
    await this.refreshSecurityUser()
    const label = provider.charAt(0).toUpperCase() + provider.slice(1)
    this.cancelMfaLinkChallenge()
    this.showSnackbar(`${label} provider linked successfully`, SnackBarType.success, '', 3000)
  }

  cancelMfaLinkChallenge(): void {
    const provider = this.mfaLinkProvider()
    if (provider) this.loading[provider] = false
    this.mfaLinkResolver.set(null)
    this.mfaLinkProvider.set('')
    this.mfaLinkStep.set('idle')
    this.mfaLinkVerificationId.set('')
    this.mfaLinkPhoneHint.set('')
    this.mfaLinkPhoneFactorIndex.set(0)
    this.mfaLinkPhoneFactorAttempts.set([])
    this.mfaLinkOtp.reset('')
    this.mfaLinkTotpCode.reset('')
    this.mfaLinkError.set('')
    this.cdr.detectChanges()
  }

  isMfaLinkLoading(): boolean {
    const provider = this.mfaLinkProvider()
    return provider ? this.loading[provider] : false
  }

  ngOnDestroy(): void {
    if (this.recaptchaVerifier) {
      try { this.recaptchaVerifier.clear() } catch { /* ignore */ }
    }
  }

}
