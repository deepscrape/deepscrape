import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Auth, verifyPasswordResetCode, confirmPasswordReset, applyActionCode } from '@angular/fire/auth';
import { TranslateService } from '@ngx-translate/core';
import { ThemeService, FirestoreService, AuthService, WindowToken } from 'src/app/core/services';
import { ORIGINS } from 'src/app/core/guards/host-routing.policy';
import { checkPasswordStrength, getErrorMessage, isStrongPassword } from 'src/app/core/functions';
import { Observable } from 'rxjs';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { timer } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-reset-password-handler',
  imports: [
    CommonModule,
    RouterModule,
    FormsModule,
    TranslateModule,
    MatIconModule,
  ],
  templateUrl: './action-handler.component.html',
  styleUrl: './action-handler.component.scss'
})
export class ActionHandlerComponent implements OnInit {
  private window: Window = inject(WindowToken);
  private readonly destroyRef = inject(DestroyRef);
  oobCode: string | null = null;
  continueUrl: string | null = null;
  email: string | null = null;
  newPassword: string = '';
  confirmPassword: string = '';
  loading = false;
  errorMessage = '';
  successMessage = '';
  protected isDarkMode$: Observable<boolean>;
  /** Marketing apex. The brand mark must resolve to the site, never to a subdomain. */
  protected readonly apexUrl: string = ORIGINS.marketing;
  emailVerificationMode: boolean = false;
  verificationSuccess: boolean = false;
  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private auth: Auth,
    private translate: TranslateService,
    private themePicker: ThemeService,
    private firestoreService: FirestoreService,
    private authService: AuthService
  ) {
    this.isDarkMode$ = this.themePicker.isDarkMode$;
  }
  async ngOnInit() {
    this.extractQueryParams();
    
    if (!this.oobCode) {
      this.handleMissingCode();
      return;
    }

    if (this.emailVerificationMode) {
      await this.handleEmailVerification();
    } else {
      await this.handlePasswordReset();
    }
  }

  /** Extract and decode query parameters from URL */
  private extractQueryParams(): void {
    const rawOobCode = this.route.snapshot.queryParamMap.get('oobCode');
    this.oobCode = rawOobCode || null;

    const continueUrl = this.route.snapshot.queryParamMap.get('continueUrl');
    this.continueUrl = continueUrl ? decodeURIComponent(continueUrl) : null;

    const mode = this.route.snapshot.queryParamMap.get('mode');
    this.emailVerificationMode = mode === 'verifyEmail';
  }

  /** Handle missing verification or reset code */
  private handleMissingCode(): void {
    this.errorMessage = this.emailVerificationMode
      ? this.translate.instant('EMAIL_VERIFICATION.NO_CODE_FOUND')
      : this.translate.instant('RESET_PASSWORD.NO_CODE_FOUND');
  }

  /** Handle email verification flow */
  private async handleEmailVerification(): Promise<void> {
    this.loading = true;
    this.errorMessage = '';
    this.successMessage = '';

    try {
      this.validateOobCode();
      await this.applyEmailVerification();
      await this.syncFirestoreAfterVerification();
      this.completeEmailVerification();
    } catch (error: any) {
      this.handleEmailVerificationError(error);
    }
  }

  /** Validate that oobCode is not empty */
  private validateOobCode(): void {
    if (!this.oobCode || this.oobCode.trim().length === 0) {
      throw new Error('OobCode is empty or invalid');
    }
    console.log('Starting email verification with oobCode:', this.oobCode);
  }

  /** Apply action code to Firebase Auth */
  private async applyEmailVerification(): Promise<void> {
    console.log('Step 1: Applying action code...');
    try {
      await applyActionCode(this.auth, this.oobCode!);
      console.log('Step 1 ✅: Action code applied successfully');
    } catch (authError: any) {
      console.error('❌ applyActionCode failed:', authError.code, authError.message);
      this.logOobCodeDetails();
      throw authError;
    }
  }

  /** Log oobCode diagnostic information */
  private logOobCodeDetails(): void {
    console.error('Attempted oobCode:', this.oobCode);
    console.error('OobCode details:', {
      length: this.oobCode?.length,
      startsWithLetter: /^[a-zA-Z]/.test(this.oobCode || ''),
      containsSlash: this.oobCode?.includes('/'),
      containsEqual: this.oobCode?.includes('='),
      containsUnderscore: this.oobCode?.includes('_'),
      containsDash: this.oobCode?.includes('-'),
    });
  }

  /** Sync Firestore and refresh AuthService after verification */
  private async syncFirestoreAfterVerification(): Promise<void> {
    console.log('Step 2: Syncing Firestore...');
    const currentUser = this.auth.currentUser;
    if (!currentUser) {
      // Action links can be opened while logged out. Auth state will update on next sign-in.
      console.log('No authenticated user during verification link handling; skipping profile sync.');
      return;
    }

    console.log('Step 3: Updating Firestore...');
    await firstValueFrom(this.authService.updateEmailVerificationStatus(currentUser.uid));

    console.log('Step 4: Refreshing user data...');
    await this.authService.refreshUserData();
  }

  /** Complete email verification and redirect */
  private completeEmailVerification(): void {
    this.verificationSuccess = true;
    this.successMessage = this.translate.instant('EMAIL_VERIFICATION.SUCCESS');
    this.loading = false;
    console.log('✅ Email verification completed successfully');

    const redirectUrl = this.resolveRedirectUrl();
    timer(2000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        // An absolute URL must not go through the router: navigateByUrl treats it as an
        // in-app path, fails to match, and the user lands nowhere with no error. Reachable
        // whenever a continueUrl points at another origin, which is the norm once the app
        // and the marketing site are separate origins. Hand it to the browser instead.
        if (/^https?:\/\//i.test(redirectUrl)) {
          this.window.location.assign(redirectUrl);
          return;
        }
        this.router.navigateByUrl(redirectUrl);
      });
  }

  /** Resolve the redirect URL after email verification */
  private resolveRedirectUrl(): string {
    if (!this.continueUrl) {
      return '/service/onboarding';
    }

    try {
      const url = new URL(this.continueUrl, this.window.location.origin);
      if (url.host === this.window.location.host) {
        return url.pathname + url.search + url.hash;
      }
      if (this.continueUrl.startsWith('https://')) {
        return this.continueUrl;
      }
    } catch {
      console.warn('Invalid continueUrl, using dashboard');
    }
    return '/service/onboarding';
  }

  /** Handle email verification errors */
  private handleEmailVerificationError(error: any): void {
    this.loading = false;
    console.error('❌ Email verification error:', error);

    if (!error.code) {
      this.errorMessage = this.translate.instant('EMAIL_VERIFICATION.FAILED') 
        || 'Something went wrong. Please try again later.';
      return;
    }

    this.errorMessage = getErrorMessage(error.code, this.translate);

    if (error.code === 'auth/invalid-action-code') {
      this.errorMessage += '\n\nEmail verification link is invalid. This usually means:\n'
        + '1. The link has been used already\n'
        + '2. The link has expired (links expire after 24 hours)\n'
        + '3. There may be a URL encoding issue\n\n'
        + 'Please request a new verification email or contact support.';
    }
  }

  /** Handle password reset flow */
  private async handlePasswordReset(): Promise<void> {
    try {
      console.log('Step 1: Verifying password reset code...');
      this.email = await verifyPasswordResetCode(this.auth, this.oobCode!);
      console.log('Step 1 ✅: Password reset code verified');
    } catch (error: any) {
      console.error('Password reset verification error:', error);
      this.errorMessage = this.translate.instant('RESET_PASSWORD.INVALID_OR_EXPIRED_LINK');
    }
  }

  async resetPassword() {
    if (!this.isFormValid() || !this.oobCode) {
      this.errorMessage = this.translate.instant('RESET_PASSWORD.FORM_INVALID');
      return;
    }

    this.loading = true;
    this.errorMessage = '';
    this.successMessage = '';

    try {
      await confirmPasswordReset(this.auth, this.oobCode, this.newPassword);
      this.successMessage = this.translate.instant('RESET_PASSWORD.SUCCESS');
      this.loading = false;
      setTimeout(() => this.router.navigate(['/service/login']), 2000);
    } catch (error: any) {
      this.loading = false;
      console.error('Password reset error:', error);
      this.errorMessage = this.translate.instant('RESET_PASSWORD.FAILED') || 'Something went wrong. Please try again later.';
    }
  }

  /** Validates password strength */
  protected getPasswordStrengthMessage(): string {
    return checkPasswordStrength(this.newPassword, (k) => this.translate.instant(k));
  }

  /** Checks if password is valid (strong) */
  protected isPasswordValid(): boolean {
    return isStrongPassword(this.newPassword);
  }

  /** Checks if passwords match */
  protected doPasswordsMatch(): boolean {
    return this.newPassword === this.confirmPassword && this.newPassword.length > 0;
  }

  /** Checks if confirm password field has validation errors */
  protected getConfirmPasswordError(): string | null {
    if (!this.confirmPassword && this.newPassword.length > 0) {
      return 'RESET_PASSWORD.CONFIRM_PASSWORD_REQUIRED';
    }
    if (this.confirmPassword && !this.doPasswordsMatch()) {
      return 'RESET_PASSWORD.PASSWORDS_NOT_MATCH';
    }
    return null;
  }

  /** Checks if form is valid for submission */
  protected isFormValid(): boolean {
    return (
      this.newPassword.length > 0 &&
      this.confirmPassword.length > 0 &&
      this.isPasswordValid() &&
      this.doPasswordsMatch()
    );
  }
}
