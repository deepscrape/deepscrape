
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { MatIconModule } from '@angular/material/icon'
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import { ActivatedRoute, Router } from '@angular/router'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { firstValueFrom } from 'rxjs'
import { SnackBarType } from 'src/app/core/components'
import { resolveSafeReturnUrl } from 'src/app/core/functions'
import { AuthService, DeviceVerificationService, SnackbarService } from 'src/app/core/services'
import { Auth, PhoneAuthProvider, RecaptchaVerifier, reauthenticateWithCredential } from '@angular/fire/auth'

@Component({
  selector: 'app-device-verification-route',
  standalone: true,
  imports: [FormsModule, MatIconModule, MatProgressSpinnerModule, TranslateModule],
  templateUrl: './device-verification.component.html',
  styleUrl: './device-verification.component.scss',
})
export class DeviceVerificationRouteComponent implements OnInit, OnDestroy {
  private authService = inject(AuthService)
  private deviceVerification = inject(DeviceVerificationService)
  private snackbarService = inject(SnackbarService)
  private readonly translate = inject(TranslateService)
  private router = inject(Router)
  private route = inject(ActivatedRoute)
  private fireAuth = inject(Auth)

  readonly verificationSent = signal(false)
  readonly verificationMethod = signal<'email' | 'sms'>('email')
  readonly verificationExpiry = signal<Date | null>(null)
  readonly isSending = signal(false)
  readonly isVerifying = signal(false)
  readonly timeRemaining = signal('00:00')
  readonly infoMessage = signal('')
  readonly action = signal<string | null>(null)
  readonly sessionId = signal<string | undefined>(undefined)
  readonly mfaPhoneOtp = signal('')
  readonly mfaVerificationId = signal<string | null>(null)
  readonly showMfaInput = signal(false)
  readonly isMfaSending = signal(false)
  readonly phoneSetupRequired = signal(false)
  readonly isLinkingPhone = signal(false)

  codeInput = ''
  deviceName = ''
  /** Number typed into the setup field when the account has none. */
  phoneNumberInput = ''
  /** The OTP box is completing a phone enrolment, not re-authenticating a known factor. */
  private pendingPhoneEnrollment = false

  private countdownIntervalId: ReturnType<typeof setInterval> | null = null
  private currentUserId = ''

  /** Translation key for the current action context. */
  get actionLabel(): string {
    switch (this.action()) {
      case 'unlink_provider': return 'DEVICE_VERIFICATION.ACT_UNLINK'
      case 'api_key_reveal': return 'DEVICE_VERIFICATION.ACT_REVEAL'
      case 'billing_change': return 'DEVICE_VERIFICATION.ACT_BILLING'
      case 'login': return 'DEVICE_VERIFICATION.ACT_LOGIN'
      default: return 'DEVICE_VERIFICATION.ACT_CONTINUE'
    }
  }

  /** Whether the verification is for a login flow (vs a high-risk action). */
  get isLoginFlow(): boolean {
    return this.action() === 'login' || this.action() === null
  }

  resendCurrentChannel(): Promise<void> {
    const channel = this.verificationMethod() === 'sms' ? 'sms' : 'email'
    return this.sendCode(channel)
  }

  switchChannel(): Promise<void> {
    const newChannel = this.verificationMethod() === 'sms' ? 'email' : 'sms'
    this.verificationSent.set(false)
    this.infoMessage.set('')
    return this.sendCode(newChannel)
  }

  async ngOnInit(): Promise<void> {
    const user = await firstValueFrom(this.authService.user$, { defaultValue: null })
    const userId = user?.uid

    if (!userId) {
      await this.router.navigate(['/service/login'], { queryParams: { returnUrl: this.getReturnUrl() } })
      return
    }

    this.currentUserId = userId
    this.deviceName = this.getDefaultDeviceName()

    // Read action and sessionId from query params
    this.action.set(this.route.snapshot.queryParamMap.get('action') || 'login')
    const qpSessionId = this.route.snapshot.queryParamMap.get('sessionId')
    if (qpSessionId) {
      this.sessionId.set(qpSessionId)
    }

    const fingerprint = this.deviceVerification.getDeviceFingerprint()
    const trusted = await this.deviceVerification.isDeviceTrusted(userId, fingerprint)

    if (trusted) {
      await this.router.navigateByUrl(this.getReturnUrl())
      return
    }

    // A sign-in that just completed a second factor is already proof for this device:
    // `sign_in_second_factor` is signed by Firebase and a client cannot set it. Asking for
    // another code straight after two factors is the step real platforms never take.
    const tokenResult = await this.fireAuth.currentUser?.getIdTokenResult()
    if ((tokenResult?.claims as any)?.firebase?.sign_in_second_factor) {
      const trustedByMfa = await this.deviceVerification.verifyDevice(
        userId,
        'mfa',
        (this.deviceName || this.getDefaultDeviceName()).trim(),
        this.sessionId(),
      )
      if (trustedByMfa) {
        await this.router.navigateByUrl(this.getReturnUrl())
        return
      }
    }

    this.countdownIntervalId = setInterval(() => {
      if (!this.verificationExpiry()) {
        return
      }

      const remaining = this.getTimeRemaining()
      this.timeRemaining.set(remaining)

      if (remaining === '00:00') {
        this.verificationSent.set(false)
        this.infoMessage.set(this.translate.instant('DEVICE_VERIFICATION.CODE_EXPIRED'))
      }
    }, 1000)

    await this.sendCode('auto')
  }

  ngOnDestroy(): void {
    if (this.countdownIntervalId) {
      clearInterval(this.countdownIntervalId)
      this.countdownIntervalId = null
    }
  }

  async sendCode(method: 'email' | 'sms' | 'auto'): Promise<void> {
    if (!this.currentUserId) {
      return
    }

    this.isSending.set(true)
    this.infoMessage.set('')

    try {
      const result = await this.deviceVerification.sendVerificationCode(this.currentUserId, method, this.sessionId())

      if (!result.success) {
        // SMS was asked for and there is no number to send it to. Offer the field instead
        // of the silent email downgrade that made the channel switch look dead.
        if (result.smsUnavailable) {
          this.verificationSent.set(false)
          this.phoneSetupRequired.set(true)
          this.infoMessage.set(this.translate.instant('DEVICE_VERIFICATION.PHONE_SETUP_HINT'))
          return
        }

        this.snackbarService.showSnackbar(result.message || this.translate.instant('DEVICE_VERIFICATION.SEND_FAILED'), SnackBarType.error, '', 5000)
        return
      }

      const effectiveMethod = result.method || (method === 'sms' ? 'sms' : 'email')
      this.verificationMethod.set(effectiveMethod)
      this.verificationExpiry.set(this.deviceVerification.verificationExpiry())
      this.verificationSent.set(true)

      if (effectiveMethod === 'sms' && result.deliveryStatus === 'pending_client_mfa') {
        this.infoMessage.set(result.message || this.translate.instant('DEVICE_VERIFICATION.PHONE_INITIATING'))
        // Auto-trigger Firebase phone verification
        this.initMfaPhoneChallenge()
      } else if (!this.infoMessage()) {
        this.infoMessage.set(result.message || this.translate.instant('DEVICE_VERIFICATION.CODE_SENT'))
      }

      this.snackbarService.showSnackbar(this.infoMessage(), SnackBarType.info, '', 4500)
    } finally {
      this.isSending.set(false)
    }
  }

  async verify(): Promise<void> {
    if (!this.currentUserId || this.codeInput.trim().length !== 6) {
      return
    }

    this.isVerifying.set(true)

    try {
      const success = await this.deviceVerification.verifyDevice(
        this.currentUserId,
        this.codeInput.trim(),
        (this.deviceName || this.getDefaultDeviceName()).trim(),
        this.sessionId(),
      )

      if (!success) {
        this.snackbarService.showSnackbar(this.translate.instant('DEVICE_VERIFICATION.INVALID_CODE'), SnackBarType.error, '', 5000)
        return
      }

      this.snackbarService.showSnackbar(this.translate.instant('DEVICE_VERIFICATION.VERIFIED_SIGNIN'), SnackBarType.success, '', 3000)
      await this.router.navigateByUrl(this.getReturnUrl())
    } finally {
      this.isVerifying.set(false)
    }
  }

  /**
   * Initiate Firebase phone MFA challenge for SMS delivery.
   * Uses PhoneAuthProvider to send an SMS via Firebase client SDK.
   */
  private async initMfaPhoneChallenge(): Promise<void> {
    try {
      this.isMfaSending.set(true)
      this.showMfaInput.set(false)

      const user = await firstValueFrom(this.authService.user$, { defaultValue: null })
      if (!user?.phoneNumber) {
        this.showMfaInput.set(false)
        this.infoMessage.set(this.translate.instant('DEVICE_VERIFICATION.NO_PHONE'))
        return
      }

      // Create reCAPTCHA verifier
      const recaptchaVerifier = new RecaptchaVerifier(
        this.fireAuth,
        'mfa-recaptcha-container',
        { size: 'invisible' },
      )
      await recaptchaVerifier.render()

      // Send SMS via Firebase PhoneAuthProvider
      const phoneProvider = new PhoneAuthProvider(this.fireAuth)
      const verificationId = await phoneProvider.verifyPhoneNumber(user.phoneNumber, recaptchaVerifier)

      this.mfaVerificationId.set(verificationId)
      this.showMfaInput.set(true)
      this.infoMessage.set(
        this.translate.instant('DEVICE_VERIFICATION.SMS_SENT_PREFIX') +
        `${user.phoneNumber.slice(0, -4)}****` +
        this.translate.instant('DEVICE_VERIFICATION.SMS_SENT_SUFFIX')
      )
    } catch (error) {
      console.error('Failed to initiate phone MFA challenge:', error)
      this.showMfaInput.set(false)
      this.infoMessage.set(this.translate.instant('DEVICE_VERIFICATION.SMS_FAILED'))
    } finally {
      this.isMfaSending.set(false)
    }
  }

  /**
   * Add a phone number to an account that has none (Google/GitHub sign-in), then reuse the
   * OTP box to prove it. The number links through Auth MFA enrolment; the user document is
   * written by the server because `phoneNumber`/`phoneVerified` are protected fields.
   */
  async addPhoneForSms(): Promise<void> {
    const phoneNumber = this.phoneNumberInput.trim()
    if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
      this.snackbarService.showSnackbar(
        this.translate.instant('DEVICE_VERIFICATION.PHONE_INVALID'),
        SnackBarType.error,
        '',
        5000,
      )
      return
    }

    this.isLinkingPhone.set(true)
    this.infoMessage.set('')

    try {
      const recaptchaVerifier = new RecaptchaVerifier(
        this.fireAuth,
        'mfa-recaptcha-container',
        { size: 'invisible' },
      )

      const verificationId = await this.authService.startPhoneMfaEnrollment(phoneNumber, recaptchaVerifier)

      this.mfaVerificationId.set(verificationId)
      this.pendingPhoneEnrollment = true
      this.phoneSetupRequired.set(false)
      this.showMfaInput.set(true)
      this.infoMessage.set(
        this.translate.instant('DEVICE_VERIFICATION.SMS_SENT_PREFIX') +
        `${phoneNumber.slice(0, -4)}****` +
        this.translate.instant('DEVICE_VERIFICATION.SMS_SENT_SUFFIX'),
      )
    } catch (error) {
      console.error('Failed to start phone enrolment:', error)
      this.infoMessage.set(this.translate.instant('DEVICE_VERIFICATION.SMS_FAILED'))
    } finally {
      this.isLinkingPhone.set(false)
    }
  }

  /**
   * Complete the phone MFA challenge with the user-entered OTP,
   * then trust the device via the backend (skipping custom code check).
   */
  async verifyPhoneMfa(): Promise<void> {
    const otp = this.mfaPhoneOtp()
    if (!otp || otp.length < 6 || !this.mfaVerificationId()) {
      return
    }

    this.isVerifying.set(true)
    this.infoMessage.set(this.translate.instant('DEVICE_VERIFICATION.VERIFYING_PHONE'))

    try {
      // Complete Firebase phone verification
      const credential = PhoneAuthProvider.credential(this.mfaVerificationId()!, otp)

      const firebaseUser = this.fireAuth.currentUser
      if (this.pendingPhoneEnrollment) {
        // A number that is not on the account yet. `reauthenticateWithCredential` rejects
        // that, so it is completed as an enrolment and then persisted by the server.
        await this.authService.completePhoneMfaEnrollment(
          this.mfaVerificationId()!,
          otp,
          'Device verification',
        )
        if (firebaseUser) {
          await firstValueFrom(this.authService.updatePhoneVerificationStatus(
            firebaseUser.uid,
            true,
            this.phoneNumberInput.trim() || undefined,
          ))
          await this.authService.refreshUserData(firebaseUser.uid)
        }
        this.pendingPhoneEnrollment = false
      } else if (firebaseUser) {
        // Reauthenticate to prove phone ownership
        await reauthenticateWithCredential(firebaseUser, credential)
      }

      // The factor takes effect on the next sign-in, and that sign-in is what mints the
      // `sign_in_second_factor` claim this device is trusted with. So stop here and let the
      // login page run the real challenge, instead of sending a code the server cannot check.
      this.snackbarService.showSnackbar(
        this.translate.instant('DEVICE_VERIFICATION.PHONE_SIGN_IN_AGAIN'),
        SnackBarType.success,
        '',
        5000,
      )
      await firstValueFrom(this.authService.logout())
      await this.router.navigate(['/service/login'], { queryParams: { returnUrl: this.getReturnUrl() } })
    } catch (error) {
      console.error('Phone MFA verification failed:', error)
      this.snackbarService.showSnackbar(this.translate.instant('DEVICE_VERIFICATION.INVALID_PHONE_CODE'), SnackBarType.error, '', 5000)
    } finally {
      this.isVerifying.set(false)
    }
  }

  async cancel(): Promise<void> {
    if (this.isLoginFlow) {
      await firstValueFrom(this.authService.logout())
      await this.router.navigate(['/service/login'])
    } else {
      await this.router.navigateByUrl(this.getReturnUrl())
    }
  }

  getTimeRemaining(): string {
    const expiry = this.verificationExpiry()
    if (!expiry) {
      return '00:00'
    }

    const diff = Math.max(0, expiry.getTime() - Date.now())
    const minutes = Math.floor(diff / 60000)
    const seconds = Math.floor((diff % 60000) / 1000)

    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  }

  private getDefaultDeviceName(): string {
    if (typeof navigator === 'undefined') {
      return 'Unknown device'
    }

    const ua = navigator.userAgent || ''
    if (/mobile/i.test(ua)) {
      return 'Mobile device'
    }
    if (/tablet|ipad/i.test(ua)) {
      return 'Tablet'
    }
    return 'Desktop browser'
  }

  private getReturnUrl(): string {
    return resolveSafeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'))
  }
}
