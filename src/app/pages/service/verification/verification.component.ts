import { Component, OnInit, OnDestroy, AfterViewInit, ViewChild, ChangeDetectionStrategy, ChangeDetectorRef, DOCUMENT, inject, PLATFORM_ID } from '@angular/core';
import { Auth, sendEmailVerification, User, RecaptchaVerifier, ConfirmationResult } from '@angular/fire/auth';
import { ActivatedRoute, Router } from '@angular/router';
import { isPlatformBrowser } from '@angular/common';

import { AuthService, FirestoreService, GuestTrackingService, LocalStorage, SnackbarService } from 'src/app/core/services';
import { WindowToken } from 'src/app/core/services';
import { SnackBarType } from 'src/app/core/components';
import { MatIcon } from '@angular/material/icon';
import { delay, finalize, firstValueFrom, interval, Subscription, timer } from 'rxjs';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Loading } from 'src/app/core/types';
import { formatWait, getErrorMessage, resendStampKey, resendWaitMs } from 'src/app/core/functions';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { OtpInputComponent } from 'src/app/shared/otp-input/otp-input.component';
import { resolveSafeReturnUrl } from 'src/app/core/functions';

@Component({
  selector: 'app-verification',
  standalone: true,
  imports: [MatIcon, ReactiveFormsModule, TranslateModule, OtpInputComponent],
  templateUrl: './verification.component.html',
  styleUrl: './verification.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VerifyEmailComponent implements OnInit, OnDestroy, AfterViewInit {

  @ViewChild('recaptcha') recaptcha: any;
  user: User | null = null;
  logoutSubscription!: Subscription;
  timerSubscriber!: Subscription;
  loading: Loading = {
    email: false,
    remove: false,
    password: false,
    mfa: false,
    logout: false,
    phone: false,
    code: false,
    google: false,
    github: false,
  };
  errorMessage: string = '';

  /**
   * Milliseconds the resend button is still held for, or `0` when it may be pressed.
   *
   * Only ever set from a stamp the provider wrote, so a failed send leaves it at `0` and the
   * button stays live: a cooldown after a send that did not happen would hide the failure behind
   * a disabled control.
   */
  cooldownLeft = 0;
  private cooldownSub?: Subscription;

  public recaptchaVerifier!: RecaptchaVerifier;
  public confirmationResult!: ConfirmationResult;
  public verificationMethod: 'email' | 'phone' | null = null;
  public phoneVerificationForm!: FormGroup;
  private pendingVerificationId: string | null = null;
  private pendingPhoneNumber: string | null = null;
  private readonly platformId = inject(PLATFORM_ID);
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly window = inject(WindowToken);
  private readonly snackbarService = inject(SnackbarService);
  private readonly authService = inject(AuthService);
  private readonly firestoreService = inject(FirestoreService);
  private readonly guestTrackingService = inject(GuestTrackingService);
  private readonly fb = inject(FormBuilder);
  private readonly document = inject(DOCUMENT);
  private readonly translate = inject(TranslateService);
  private readonly cdr = inject(ChangeDetectorRef);
  /** Platform-guarded store: a no-op during SSR and when the browser blocks storage. */
  private readonly store = inject(LocalStorage);

  constructor() {
    this.phoneVerificationForm = this.fb.group({
      phoneNumber: ['', [Validators.required, Validators.pattern(/^\+[1-9]\d{7,14}$/)]],
      verificationCode: ['', [Validators.required, Validators.minLength(6), Validators.maxLength(6)]],
    });
  }

  ngOnInit(): void {
    this.user = this.auth.currentUser
    const navState = (this.router.getCurrentNavigation()?.extras?.state || this.window.history.state || {}) as {
      verificationId?: string;
      phoneNumber?: string;
    }
    this.pendingVerificationId = typeof navState.verificationId === 'string' ? navState.verificationId : null
    this.pendingPhoneNumber = typeof navState.phoneNumber === 'string' ? navState.phoneNumber : null
    this.checkVerificationStatus()
  }

  ngAfterViewInit(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }
    this.initializeRecaptcha()
  }

  private initializeRecaptcha(): void {
    // Ensure the recaptcha-verification element is available before initializing

    console.log(this.document.getElementById('recaptcha-verification'))
    if (this.document.getElementById('recaptcha-verification')) {
      this.recaptchaVerifier = new RecaptchaVerifier(this.auth, 'recaptcha-verification', {
        'size': 'invisible',
        'callback': (response: any) => {
          console.log('Recaptcha solved on verification:', response);
          if (this.verificationMethod === 'phone' && this.phoneVerificationForm.get('phoneNumber')?.valid) {
            this.sendPhoneVerificationCode();
          }
        }, 'expired-callback': () => {
          const message = this.translate.instant('VERIFICATION.RECAPTCHA_EXPIRED');
          this.showSnackbar(message, SnackBarType.warning);
        }
      });
      this.recaptchaVerifier.render();
    } else {
      console.warn('Recaptcha container element not found. Recaptcha will not be initialized.');
    }
  }

  private async checkVerificationStatus(): Promise<void> {
    if (!this.user) {
      this.router.navigate(['/service/login'], { queryParams: { returnUrl: this.getReturnUrl() } });
      return;
    }
    this.loading.email = true;
    try {
      // The link in the email is applied by Firebase's own action handler, which then
      // redirects here. The restored session still carries the pre-verification token,
      // so `emailVerified` reads false until the profile is reloaded — that is why the
      // page looked stuck until the user pressed "go to login" and signed in again.
      await this.user.reload().catch(() => undefined);
      const userData = await this.firestoreService.getUserData(this.user.uid);

      const provider = userData?.providerId ?? '';
      const isSocial = ['google.com', 'github.com', 'facebook.com'].includes(provider);
      // Social providers have email implicitly verified; password accounts must verify email
      const emailOk = isSocial || this.user.emailVerified === true;
      // null  = no phone was registered at signup (optional) → allowed through
      // false = phone was registered at signup but NOT yet verified → must verify
      // true  = phone verified
      const phoneOk = userData?.phoneVerified !== false;

      if (emailOk) {
        await this.ensureCurrentSessionMetrics(provider || undefined);
      }

      this.loading.email = false;

      if (emailOk && phoneOk) {
        this.router.navigateByUrl(this.getReturnUrl());
        return;
      }
      if (!emailOk) {
        this.verificationMethod = 'email';
        // Signup already sent one and stamped it, so on the normal path this only starts the
        // countdown. The send fires for someone who arrived WITHOUT one -- a saved link, another
        // browser -- which is the case that otherwise leaves them staring at an inbox with no mail
        // in it. Once stamped, a resend is the user's choice, not something the page does for them.
        if (this.stamp() === null) {
          void this.resendVerificationEmail();
        } else {
          this.startCooldown();
        }
        return;
      }
      // emailOk && !phoneOk: phone was registered but never verified
      this.verificationMethod = 'phone';
      this.phoneVerificationForm.get('phoneNumber')?.setValue(this.user.phoneNumber ?? userData?.phoneNumber ?? this.pendingPhoneNumber ?? '');
    } catch (error: any) {
      console.error('Error checking verification status:', error);
      this.loading.email = false;
    } finally {
      this.cdr.markForCheck();
    }
  }

  async sendPhoneVerificationCode() {
    this.loading.phone = true;
    this.errorMessage = '';
    try {
      if (!this.recaptchaVerifier) {
        this.initializeRecaptcha();
      }

      const phoneNumber = this.phoneVerificationForm.get('phoneNumber')?.value;
      if (!phoneNumber) {
        throw new Error('Phone number is required.');
      }

      this.pendingPhoneNumber = phoneNumber;

      if (this.user) {
        this.pendingVerificationId = await this.authService.startPhoneMfaEnrollment(phoneNumber, this.recaptchaVerifier);
      } else {
        this.confirmationResult = await this.authService.signInWithPhone(phoneNumber, this.recaptchaVerifier);
        this.pendingVerificationId = this.confirmationResult?.verificationId || null;
      }
      const message = this.translate.instant('AUTH_ERRORS.PHONE_VERIFICATION_SENT');
      this.showSnackbar(message, SnackBarType.success);
    } catch (error: any) {
      console.error('Error sending phone verification code:', error);
      this.errorMessage = getErrorMessage(error, this.translate);
      this.showSnackbar(this.errorMessage, SnackBarType.error, '', 5000);
    } finally {
      this.loading.phone = false;
      this.cdr.markForCheck();
    }
  }

  async verifyPhoneNumberCode() {
    this.loading.code = true;
    this.errorMessage = '';
    try {
      const verificationCode = this.phoneVerificationForm.get('verificationCode')?.value;
      if (!verificationCode) {
        throw new Error('Verification code is required.');
      }
      const verificationId = this.confirmationResult?.verificationId || this.pendingVerificationId;
      if (!verificationId) {
        throw new Error(this.translate.instant('VERIFICATION.NO_CODE_INITIATED'));
      }

      let userCredential;
      if (this.user) {
        await this.authService.completePhoneMfaEnrollment(verificationId, verificationCode, 'SMS verification');
        userCredential = { user: this.user };
      } else {
        userCredential = await this.authService.verifyPhoneCode(verificationId, verificationCode);
      }
      if (userCredential.user) {
        const verifiedPhoneNumber = this.phoneVerificationForm.get('phoneNumber')?.value || this.pendingPhoneNumber || this.user?.phoneNumber || null;
        await firstValueFrom(this.authService.updatePhoneVerificationStatus(userCredential.user.uid, true, verifiedPhoneNumber ?? undefined));
        await this.authService.refreshUserData(userCredential.user.uid);

        await this.ensureCurrentSessionMetrics('phone', true);

        this.pendingVerificationId = null;
        this.confirmationResult = null as any;
        const message = this.translate.instant('VERIFICATION.PHONE_VERIFIED_SUCCESS');
        this.showSnackbar(message, SnackBarType.success);
        this.router.navigateByUrl(this.getReturnUrl());
      } else {
        const message = this.translate.instant('AUTH_ERRORS.USER_NULL_AFTER_PHONE_VERIFICATION');
        this.showSnackbar(message, SnackBarType.error, '', 5000);
      }
    } catch (error: any) {
      console.error('Error verifying phone number code:', error);
      this.errorMessage = getErrorMessage(error, this.translate);
      this.showSnackbar(this.errorMessage, SnackBarType.error, '', 5000);
    } finally {
      this.loading.code = false;
      this.cdr.markForCheck();
    }
  }

  resetPhoneVerification() {
    this.phoneVerificationForm.reset();
    this.errorMessage = '';
    this.confirmationResult = null as any; // Reset confirmation result
    if (this.recaptchaVerifier) {
      this.recaptchaVerifier.clear();
      this.recaptchaVerifier.render();
    }
  }

  /** Epoch ms of the last verification email the provider accepted for this account, or null. */
  private stamp(): number | null {
    const raw = this.store.getItem(resendStampKey(this.user?.uid ?? ''));
    const value = raw ? Number(raw) : NaN;

    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /**
   * Hold the button for whatever is left of the cooldown, and release it the second it expires.
   *
   * Read back from the stamp rather than counted down from a value passed in: a reload mid-window
   * then shows the real remaining time instead of a fresh five minutes.
   * @return {void}
   */
  private startCooldown(): void {
    this.cooldownSub?.unsubscribe();
    this.cooldownLeft = resendWaitMs(this.stamp());

    if (this.cooldownLeft <= 0) {
      this.cdr.markForCheck();
      return;
    }

    this.cooldownSub = interval(1000).subscribe(() => {
      this.cooldownLeft = resendWaitMs(this.stamp());

      if (this.cooldownLeft <= 0) {
        this.cooldownSub?.unsubscribe();
      }

      this.cdr.markForCheck();
    });
  }

  /** `m:ss` left on the resend button, or '' once it may be pressed. */
  cooldownLabel(): string {
    return this.cooldownLeft > 0 ? formatWait(this.cooldownLeft) : '';
  }

  async resendVerificationEmail() {
    // Two guards, and both matter: `loading` stops a double click landing twice before change
    // detection repaints, and the cooldown stops the third attempt pretending to be the first.
    if (this.loading.email || this.cooldownLeft > 0) {
      return;
    }

    this.loading.email = true;
    try {
      if (this.auth.currentUser) {
        this.auth.useDeviceLanguage();
        const continueUrl = this.getAbsoluteContinueUrl(this.getReturnUrl());

        await sendEmailVerification(
          this.auth.currentUser,
          continueUrl
            ? {
                url: continueUrl,
                handleCodeInApp: false,
              }
            : undefined,
        );

        // Stamped only AFTER the provider accepted it, which is the only evidence a client can
        // get that the email is on its way -- delivery into an inbox is not observable from here.
        // A rejection throws past this line, so a failed send never starts a cooldown.
        this.store.setItem(resendStampKey(this.auth.currentUser.uid), String(Date.now()));
        this.startCooldown();
        const message = this.translate.instant('VERIFICATION.EMAIL_SENT_SUCCESS');
        this.showSnackbar(message, SnackBarType.info, '', 5000);
      } else {
        this.router.navigate(['/service/login'], { queryParams: { returnUrl: this.getReturnUrl() } });
      }
    } catch (error) {
      console.error('Error sending verification email:', error);
      this.errorMessage = getErrorMessage(error, this.translate);
      this.showSnackbar(this.errorMessage, SnackBarType.error, '', 5000);
    } finally {
      this.loading.email = false;
      this.cdr.markForCheck();
    }
  }

  goToLogin() {
    this.loading.logout = true; // Using email loading for general logout
    this.logoutSubscription = this.authService.logout().pipe(
      delay(1000),
      finalize(() => {
        this.loading.logout = false;
        this.cdr.markForCheck();
      })
    ).subscribe({
      next: () => {
        this.timerSubscriber = timer(300).subscribe(() => {
          this.router.navigate(['/service/login']);
        });
      },
      error: (error) => {
        console.error('Logout error:', error);
        this.showSnackbar(getErrorMessage(error, this.translate), SnackBarType.error, '', 5000);
      }
    })
  }

  showSnackbar(
    message: string,
    type: SnackBarType = SnackBarType.info,
    action: string | '' = '',
    duration: number = 3000
  ) {
    this.snackbarService.showSnackbar(message, type, action, duration);
  }

  ngOnDestroy(): void {
    this.logoutSubscription?.unsubscribe();
    this.timerSubscriber?.unsubscribe();
    this.cooldownSub?.unsubscribe();
    this.user = null;
    this.recaptchaVerifier?.clear()
  }

  private async ensureCurrentSessionMetrics(providerIdOverride?: string, force = false): Promise<void> {
    const currentUser = this.auth.currentUser;
    if (!currentUser) {
      return;
    }

    const providerId = providerIdOverride || currentUser.providerData?.[0]?.providerId || 'password';

    try {
      await this.guestTrackingService.ensurePostLoginSession({
        force,
        providerId,
        userId: currentUser.uid,
      });
    } catch (error) {
      console.warn('Failed to record session metrics in verification flow:', error);
    }
  }

  private getReturnUrl(): string {
    return resolveSafeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'))
  }

  public hasPendingPhoneCode(): boolean {
    return !!this.pendingVerificationId;
  }

  private getAbsoluteContinueUrl(returnUrl: string): string | null {
    if (!isPlatformBrowser(this.platformId)) {
      return null;
    }

    const origin = this.window?.location?.origin;
    if (!origin) {
      return null;
    }

    try {
      return new URL(returnUrl, origin).toString();
    } catch {
      return null;
    }
  }
}

