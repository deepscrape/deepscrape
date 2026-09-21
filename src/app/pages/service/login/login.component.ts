import {
  Component,
  OnInit,
  OnDestroy,
  AfterViewInit,
  Inject,
  ChangeDetectorRef,
  ChangeDetectionStrategy,
  inject,
  DestroyRef,
  ViewChild,
  ElementRef,
  PLATFORM_ID,
  DOCUMENT
} from '@angular/core';
import { FormGroup, FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatIcon } from '@angular/material/icon';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CommonModule, JsonPipe, isPlatformBrowser } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Observable, Subject, takeUntil } from 'rxjs';
import { firstValueFrom } from 'rxjs';

import {
  Auth,
  AuthCredential,
  ConfirmationResult,
  fetchSignInMethodsForEmail,
  getMultiFactorResolver,
  getAdditionalUserInfo,
  GithubAuthProvider,
  GoogleAuthProvider,
  isSignInWithEmailLink,
  linkWithCredential,
  MultiFactorResolver,
  OAuthProvider,
  PhoneAuthProvider,
  PhoneMultiFactorGenerator,
  RecaptchaVerifier,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithPopup,
  TotpMultiFactorGenerator,
  updateCurrentUser,
  User,
  UserCredential,
  user,
  verifyBeforeUpdateEmail,
  AdditionalUserInfo,
  UserInfo,
  MultiFactorError,
  MultiFactorAssertion
} from '@angular/fire/auth';
import { Firestore } from '@angular/fire/firestore';
import { Analytics } from '@angular/fire/analytics';
import { HttpClient } from '@angular/common/http';

import { I18nService } from 'src/app/core/i18n';
import { getBrowser, getErrorMessage, resolveSafeReturnUrl } from 'src/app/core/functions';
import { AnalyticsService, AuthService, DeviceVerificationService, FirestoreService, GuestTrackingService, SnackbarService, ThemeService, WebAuthnService, WindowToken } from 'src/app/core/services';
import { SnackBarType } from 'src/app/core/components';
import { DEFAULT_PROFILE_URL } from 'src/app/core/variables';
import { NAVIGATOR } from 'src/app/core/providers';
import { Loading } from 'src/app/core/types';
/**
 * @description Represents the credentials obtained after a login attempt,
 * including information about whether a merge is required, the user object,
 * the user credential result, and optional credential/existing UID for linking accounts.
 */
type loginCredentials = {
  mergeRequired: boolean;
  user: User;
  result: UserCredential;
  credential?: AuthCredential | undefined;
  existingUid?: string;
};

/**
 * @description Component for handling user login functionalities, including
 * email/password, Google, and GitHub authentication, as well as phone verification.
 */
@Component({
  selector: 'app-login',
  imports: [CommonModule, ReactiveFormsModule, FormsModule, RouterLink, MatProgressSpinner, MatIcon, TranslateModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent  {
  // Injected services using Angular's inject function for better testability and type safety.
  @ViewChild('recaptchaContainer', { static: false }) recaptchaContainer!: ElementRef<HTMLDivElement>;

  /** Analytics service for tracking user interactions. */
  private analytics = inject(Analytics, { optional: true });
  /** Custom analytics service for application-specific event tracking. */
  private analyticsService = inject(AnalyticsService);
  /** Platform identifier for SSR detection */
  private platformId = inject<Object>(PLATFORM_ID);
  /** A service for handling component destruction, used with `takeUntilDestroyed`. */
  private DestroyRef = inject(DestroyRef)

  private themePicker = inject(ThemeService)
  private guestTrackingService = inject(GuestTrackingService)
  private deviceVerificationService = inject(DeviceVerificationService)
  private webAuthnService = inject(WebAuthnService)
  protected isDarkMode$: Observable<boolean> = this.themePicker.isDarkMode$; 

  // Component properties
  /** Manages the loading state for various authentication methods. */
  protected loading: Loading;
  /** Reactive form group for handling login input fields (identifier and password). */
  protected loginForm: FormGroup;
  /** Stores any error messages to be displayed to the user. */
  protected errorMessage: string = '';
  protected lastLoginHint: {
    providerId: string;
    providerLabel: string;
    maskedIdentifier: string;
    updatedAt: string;
  } | null = null;
  /** Instance of Firebase RecaptchaVerifier for phone authentication. */
  public recaptchaVerifier!: RecaptchaVerifier;
  /** Stores the confirmation result after sending a phone verification code. */
  public confirmationResult!: ConfirmationResult;
  /** Tracks the currently active authentication method (email or phone). */
  public currentAuthMethod: 'email' | 'phone' | null = null;
  /** Indicates whether an SMS verification code has been sent for phone login. */
  public phoneVerificationSent: boolean = false;
  /** Stores a pending credential for linking accounts in case of existing accounts with different providers. */
  protected pendingCredential: AuthCredential | null = null;
  public showMfaChallenge = false;
  public mfaCode = '';
  private mfaResolver: MultiFactorResolver | null = null;
  private mfaEnrollmentUid = '';
  private mfaVerificationId = '';
  public mfaFactorType: 'totp' | 'phone' = 'totp';
  public mfaPhoneDisplay = '';
  private mfaProviderId = 'password';
  public mfaDisplayName = 'Authenticator app';
  public mfaAvailableFactors: Array<'totp' | 'phone'> = [];

  // Subscriptions to manage memory leaks
  /** Subject for unsubscribing all subscriptions. */
  private destroy$ = new Subject<void>();

  /** Debounce timer for analytics events. */
  private analyticsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Analytics event queue for batching. */
  private analyticsEventQueue: Array<{ eventType: string; metadata?: Record<string, unknown> }> = [];
  private window = inject(WindowToken);

  /**
   * Preload Google and GitHub providers on init for faster popup.
   */
  private googleProvider: GoogleAuthProvider;
  private githubProvider: GithubAuthProvider;

  /**
   * @description Constructor for LoginComponent.
   * Initializes services and sets up the login form.
   * @param {FormBuilder} formBuilder - Service for building reactive forms.
   * @param {Router} router - Service for navigating between routes.
   * @param {ActivatedRoute} route - Provides access to information about a route associated with a component.
   * @param {FirestoreService} firestoreService - Service for interacting with Firestore database.
   * @param {Auth} auth - Firebase Auth instance.
   * @param {AuthService} authService - Custom authentication service.
   * @param {I18nService} i18nService - Service for internationalization.
   * @param {TranslateService} translate - Service for translating content.
   * @param {HttpClient} http - Angular's HTTP client for making requests.
   * @param {Navigator} navigator - Injected `Navigator` object for browser information.
   * @param {Document} document - Injected `Document` object for DOM manipulation.
   * @param {ChangeDetectorRef} cdr - Service for triggering change detection.
   * @param {SnackbarService} snackbarService - Service for displaying snackbar messages.
   */
  constructor(
    private formBuilder: FormBuilder,
    private router: Router,
    private route: ActivatedRoute,
    private firestoreService: FirestoreService,
    private auth: Auth,
    private authService: AuthService,
    private i18nService: I18nService,
    private translate: TranslateService,
    private http: HttpClient,
    @Inject(NAVIGATOR) private navigator: Navigator,
    @Inject(DOCUMENT) private document: Document,
    private cdr: ChangeDetectorRef,
    private snackbarService: SnackbarService,
  ) {
    // Initialize loading states for various authentication methods.
    this.loading = {
      github: false,
      logout: false,
      google: false,
      remove: false,
      email: false,
      phone: false,
      code: false,
      password: false,
      mfa: false
    };

    // Initialize the login form with validation rules.
    // The identifier can be an email or a phone number.
    this.loginForm = this.formBuilder.group({
      identifier: this.formBuilder.control('', {
        validators: [
          Validators.required,
          // email  OR  E.164 phone (+1234567890)  OR  username (3-30 alphanumeric/_/-)
          Validators.pattern(/^([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\+[1-9]\d{7,14}|[a-zA-Z0-9_-]{3,30})$/)
        ]
      }),
      // Password field for email/password login.
      password: this.formBuilder.control('', {
        validators: [Validators.required, Validators.minLength(8)]
      }),
      // Commented out verificationCode and rememberMe as they are not currently in use.
      // verificationCode: [''],
      // rememberMe: [false],
    });

  }

  /**
   * @description Getter for easy access to form controls,
   * typically used in the template for validation.
   * @returns {any} The controls of the login form.
   */
  get f() {
    return this.loginForm.controls;
  }

  /**
   * @description Displays a snackbar message to the user.
   * @param {string} message - The message content to display.
   * @param {SnackBarType} [type=SnackBarType.info] - The type of snackbar (info, success, warning, error).
   * @param {string} [action=''] - Optional action text to display in the snackbar.
   * @param {number} [duration=3000] - The duration in milliseconds the snackbar will be visible.
   */
  private showSnackbar(
    message: string,
    type: SnackBarType = SnackBarType.info,
    action: string = '',
    duration: number = 3000
  ): void {
    this.snackbarService.showSnackbar(message, type, action, duration);
  }

  /**
   * @description Helper to set loading state by provider.
   * @param {string} provider - The provider for which to set the loading state.
   * @param {boolean} value - The loading state value to set.
   */
  private setLoading(provider: string, value: boolean) {
    switch (provider) {
      case 'email': this.loading.email = value; break;
      case 'google.com': this.loading.google = value; break;
      case 'github.com': this.loading.github = value; break;
      case 'phone': this.loading.phone = value; break;
      default: break;
    }
  }

  /**
   * @description Centralized error handler for login flows.
   * @param {any} error - The error object.
   * @param {string} context - Context of the error.
   * @param {string} provider - Provider causing the error.
   */
  private handleError(error: unknown, context: string, provider: string) {
    const errorMsg = this.getFriendlyAuthErrorMessage(error);
    this.errorMessage = errorMsg;
    this.showSnackbar(errorMsg, SnackBarType.error, '', 5000);
    this.trackLoginAttempt(provider, false, undefined, errorMsg, context);
    this.setLoading(provider, false);
    this.loginInProgress = false;
  }

  private async handleMfaRequired(error: MultiFactorError, providerId: string): Promise<boolean> {
    if ((error as any)?.code !== 'auth/multi-factor-auth-required') {
      return false;
    }

    try {
      const resolver = this.firestoreService.getMultiFactorResolver(error);
      const hints = resolver.hints || [];
      const phoneFactor = hints.find((hint: { factorId?: string; phoneNumber?: string }) =>
        hint?.factorId === PhoneMultiFactorGenerator.FACTOR_ID || !!hint?.phoneNumber
      );
      const totpFactor = hints.find((hint: { factorId?: string; phoneNumber?: string }) =>
        hint?.factorId === TotpMultiFactorGenerator.FACTOR_ID || (hint?.factorId === 'totp')
      );

      if (!phoneFactor && !totpFactor) {
        const factorList = hints.map((h: { factorId?: string }) => h?.factorId || 'unknown').join(', ') || 'none';
        this.errorMessage = `This account requires a second factor, but none of the enrolled factors are currently supported by this client. Enrolled factors: ${factorList}.`;
        this.showSnackbar(this.errorMessage, SnackBarType.error, '', 5000);
        return true;
      }

      this.mfaResolver = resolver;
      this.mfaProviderId = providerId;
      this.mfaCode = '';
      this.mfaAvailableFactors = [];

      const hasPhoneFactor = !!phoneFactor;
      const hasTotpFactor = !!totpFactor;
      if (hasTotpFactor) this.mfaAvailableFactors.push('totp');
      if (hasPhoneFactor) this.mfaAvailableFactors.push('phone');

      const cachedPreferences = this.authService.readCachedMfaSecurityPreferences();
      const preferredFactor: 'totp' | 'phone' = cachedPreferences?.primaryMethod === 'sms' ? 'phone' : 'totp';

      const initialFactor: 'totp' | 'phone' = hasTotpFactor && preferredFactor === 'totp' ?
        'totp' :
        (hasPhoneFactor ? 'phone' : 'totp');

      if (initialFactor === 'phone' && phoneFactor) {
        this.mfaFactorType = 'phone';
        this.mfaEnrollmentUid = '';
        this.mfaDisplayName = phoneFactor.displayName || 'Phone number';
        this.mfaPhoneDisplay = (phoneFactor as any)?.phoneNumber || 'your phone';
        await this.sendMfaSmsCode();
      } else if (totpFactor) {
        this.mfaFactorType = 'totp';
        this.mfaEnrollmentUid = totpFactor!.uid;
        this.mfaDisplayName = totpFactor!.displayName || 'Authenticator app';
        this.mfaPhoneDisplay = '';
      }

      this.mfaCode = '';
      this.showMfaChallenge = true;
      this.errorMessage = '';
      this.loading.email = false;
      this.loading.google = false;
      this.loading.github = false;
      this.loginInProgress = false;
      this.cdr.detectChanges();
      return true;
    } catch (resolverError) {
      this.handleError(resolverError, 'login:mfa:init', providerId);
      return true;
    }
  }

  private clearMfaChallenge(): void {
    this.showMfaChallenge = false;
    this.mfaResolver = null;
    this.mfaEnrollmentUid = '';
    this.mfaVerificationId = '';
    this.mfaFactorType = 'totp';
    this.mfaPhoneDisplay = '';
    this.mfaProviderId = 'password';
    this.mfaDisplayName = 'Authenticator app';
    this.mfaCode = '';
    this.mfaAvailableFactors = [];
  }

  public async switchMfaFactor(target: 'totp' | 'phone'): Promise<void> {
    if (!this.mfaResolver || !this.showMfaChallenge || this.mfaFactorType === target) {
      return;
    }

    const totpHint = this.mfaResolver.hints.find((hint: { factorId?: string }) =>
      hint?.factorId === TotpMultiFactorGenerator.FACTOR_ID || hint?.factorId === 'totp'
    );
    const phoneHint = this.mfaResolver.hints.find((hint: { factorId?: string; phoneNumber?: string }) =>
      hint?.factorId === PhoneMultiFactorGenerator.FACTOR_ID || !!hint?.phoneNumber
    );

    if (target === 'totp' && totpHint) {
      this.mfaFactorType = 'totp';
      this.mfaEnrollmentUid = totpHint.uid;
      this.mfaDisplayName = totpHint.displayName || 'Authenticator app';
      this.mfaPhoneDisplay = '';
      this.mfaCode = '';
      this.errorMessage = '';
      this.cdr.detectChanges();
      return;
    }

    if (target === 'phone' && phoneHint) {
      this.mfaFactorType = 'phone';
      this.mfaEnrollmentUid = '';
      this.mfaDisplayName = phoneHint.displayName || 'Phone number';
      this.mfaPhoneDisplay = (phoneHint as any)?.phoneNumber || 'your phone';
      this.mfaCode = '';
      this.errorMessage = '';
      await this.sendMfaSmsCode();
      this.cdr.detectChanges();
    }
  }

  public async resendMfaSmsCode(): Promise<void> {
    if (!this.showMfaChallenge || this.mfaFactorType !== 'phone') {
      return;
    }
    await this.sendMfaSmsCode();
  }

  private async sendMfaSmsCode(): Promise<void> {
    if (!this.mfaResolver) {
      throw new Error('MFA resolver is not ready. Please try again.')
    }

    const phoneHint = this.mfaResolver.hints.find((hint: { factorId?: string; phoneNumber?: string }) =>
      hint?.factorId === PhoneMultiFactorGenerator.FACTOR_ID || !!hint?.phoneNumber
    )
    if (!phoneHint) {
      throw new Error('Phone second factor is not available for this account.')
    }

    if (!this.recaptchaVerifier) {
      this.initializeRecaptcha()
    }

    const verificationId = await this.firestoreService.verifyPhoneNumberForMfa(
      {
        multiFactorHint: phoneHint,
        session: this.mfaResolver.session,
      },
      this.recaptchaVerifier
    )

    this.mfaVerificationId = verificationId
    this.showSnackbar(this.translate.instant('LOGIN.VERIFICATION_CODE_SENT_PHONE'), SnackBarType.info, '', 3000)
  }

  public async submitMfaCode(): Promise<void> {
    if (!this.mfaResolver || this.mfaCode.trim().length !== 6) {
      return;
    }

    this.loading.mfa = true;
    this.errorMessage = '';

    try {
      let assertion: MultiFactorAssertion;
      if (this.mfaFactorType === 'phone') {
        if (!this.mfaVerificationId) {
          throw new Error('Verification code was not sent. Please resend and try again.');
        }
        const credential = PhoneAuthProvider.credential(this.mfaVerificationId, this.mfaCode.trim());
        assertion = PhoneMultiFactorGenerator.assertion(credential);
      } else {
        if (!this.mfaEnrollmentUid) {
          throw new Error('Authenticator challenge is not initialized. Please try again.');
        }
        assertion = TotpMultiFactorGenerator.assertionForSignIn(this.mfaEnrollmentUid, this.mfaCode.trim());
      }

      const userCredential = await this.firestoreService.resolveMultiFactorSignIn(this.mfaResolver, assertion);
      await this.finishLogin(userCredential.user, this.mfaProviderId);
      this.clearMfaChallenge();
    } catch (error) {
      this.handleError(error, 'login:mfa:verify', this.mfaProviderId);
    } finally {
      this.loading.mfa = false;
      this.cdr.detectChanges();
    }
  }

  public cancelMfaChallenge(): void {
    this.clearMfaChallenge();
    this.errorMessage = '';
    this.cdr.detectChanges();
  }

  private async finishLogin(user: User, providerId: string): Promise<void> {
    if (user.displayName || user.photoURL) {
      await this.firestoreService.updateUserProfile(user, {
        displayName: user.displayName,
        photoURL: user.photoURL || DEFAULT_PROFILE_URL,
      });
    }

    const token = await user.getIdToken();

    await Promise.all([
      this.trackLoginAttempt(providerId, true, token),
      this.firestoreService.storeUserData(user, providerId, true)
    ]);

    await this.authService.ensureBootstrapAdminAccess(providerId)

    const isVerified = await this.onLoginUpdate({ user }, providerId);
    if (!isVerified) {
      return;
    }

    await this.ensurePostLoginTracking(user.uid, providerId);

    const fingerprint = this.deviceVerificationService.getDeviceFingerprint();
    const deviceVerified = await this.deviceVerificationService.isDeviceTrusted(user.uid, fingerprint);
    if (!deviceVerified) {
      this.showSnackbar(this.translate.instant('LOGIN.DEVICE_VERIFICATION_REQUIRED'), SnackBarType.info, '', 5000);
      const returnUrl = this.getReturnUrl();
      await this.router.navigate(['/service/device-verification'], { queryParams: { returnUrl } });
      return;
    }

    this.rememberLastLogin(providerId);

    this.firestoreService.setAnalyticsUserId(this.analytics, user.uid);
    this.showSnackbar(this.translate.instant('LOGIN.SIGN_IN_SUCCESS'), SnackBarType.success, '', 3000);
    const returnUrl = this.getReturnUrl();
    await this.router.navigateByUrl(returnUrl);
  }

  private shouldFallbackToRedirect(error: MultiFactorError): boolean {
    const code = error?.code;
    return code === 'auth/popup-blocked' ||
      code === 'auth/web-storage-unsupported' ||
      code === 'auth/operation-not-supported-in-this-environment';
  }

  private async handleRedirectSignInResult(): Promise<void> {
    try {
      const result = await this.firestoreService.getRedirectResult();
      if (!result?.user) return;

      const providerId = result.providerId || result.user.providerData?.[0]?.providerId || 'oauth';

      await this.finishLogin(result.user, providerId);
    } catch (error) {
      this.handleError(error, 'login:redirect-result', 'oauth');
    }
  }

  /**
   * @description Debounced analytics event tracker.
   * @param {any} event - Analytics event payload.
   */
  private debounceTrackEvent(event: { eventType: string; metadata?: Record<string, unknown> }) {
    this.analyticsEventQueue.push(event);
    if (this.analyticsDebounceTimer) clearTimeout(this.analyticsDebounceTimer);
    this.analyticsDebounceTimer = setTimeout(() => {
      this.analyticsService
        .batchTrackEvents([...this.analyticsEventQueue])
        .pipe(takeUntilDestroyed(this.DestroyRef))
        .subscribe({
          error: (err: unknown) => console.error('Failed to send analytics batch', err),
        });
      this.analyticsEventQueue = [];
    }, 500); // 500ms debounce
  }

  private async ensurePostLoginTracking(userId: string, providerId: string): Promise<void> {
    await this.guestTrackingService.ensurePostLoginSession({ userId, providerId }).catch((error) => {
      console.warn('Post-login session tracking failed:', error);
    });
  }

  /**
   * @description Standardized login attempt tracker.
   * @param {string} method - Login method.
   * @param {boolean} success - Success status.
   * @param {string} [token] - Firebase ID token.
   * @param {string} [errorMsg] - Error message.
   * @param {string} [context] - Context of the login attempt.
   */
  private async trackLoginAttempt(method: string, success: boolean, token?: string, errorMsg?: string, context?: string): Promise<void> {
    try {
      const browser = await getBrowser(this.navigator) || 'Unknown';
      const platform = this.navigator?.platform || 'Unknown';
      const payload = {
        method,
        success,
        timestamp: new Date().toISOString(),
        browser,
        platform,
        errorMsg: errorMsg || null,
        context: context || null
      };
      this.debounceTrackEvent({ eventType: 'login_attempt', metadata: payload });
    } catch (error) {
      console.warn('Login analytics tracking skipped:', error);
    }
  }

  /**
   * @description Lifecycle hook that is called after Angular has initialized all data-bound properties of a directive.
   * Sets the initial language and subscribes to language changes.
   */
  ngOnInit(): void {
    // Set the initial language for translation.
    this.translate.use(this.i18nService.currentLang());

    // Subscribe to language changes and update the translation service.
    this.i18nService.currentLang$
      .pipe(takeUntilDestroyed(this.DestroyRef)) // Automatically unsubscribe when the component is destroyed.
      .subscribe((lang) => {
        this.translate.use(lang);
      });

    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    // Preload providers
    this.googleProvider = new GoogleAuthProvider();
    this.googleProvider.addScope('email');
    this.googleProvider.addScope('profile');
    this.googleProvider.addScope('openid');
    this.googleProvider.setCustomParameters({ prompt: 'select_account' });
    this.githubProvider = new GithubAuthProvider();
    this.githubProvider.addScope('user:email');
    this.githubProvider.addScope('read:user');
    this.githubProvider.setCustomParameters({ prompt: 'select_account' })

    void this.handleRedirectSignInResult();
    this.lastLoginHint = this.guestTrackingService.getLastLoginHint();
  }

  protected isLastUsedProvider(providerId: string): boolean {
    return this.lastLoginHint?.providerId === providerId;
  }

  protected getLastUsedPasswordLabel(): string {
    if (!this.isLastUsedProvider('password')) {
      return '';
    }

    return this.lastLoginHint?.maskedIdentifier || this.lastLoginHint?.providerLabel || '';
  }

  private rememberLastLogin(providerId: string): void {
    const identifier = providerId === 'password'
      ? String(this.loginForm.get('identifier')?.value || '')
      : '';

    this.guestTrackingService.rememberLastLogin(providerId, identifier);
    this.lastLoginHint = this.guestTrackingService.getLastLoginHint();
  }

  /**
   * @description Lifecycle hook that is called after Angular has fully initialized a component's view.
   * Placeholder for any view-related initialization.
   */
  ngAfterViewInit(): void {
    // Recaptcha initialization might be placed here if it depends on DOM elements being present.
    // if (!isPlatformBrowser(this.platformId)) {
    //   return;
    // }
    this.initializeRecaptcha()
  }


  /**
   * @description Initializes the Firebase reCAPTCHA verifier for phone authentication.
   * This is crucial for preventing abuse of the phone sign-in flow.
   */
  private initializeRecaptcha(): void {
    // Check if the reCAPTCHA container element exists in the DOM.
    if (this.recaptchaContainer && this.recaptchaContainer.nativeElement) {
      // Initialize RecaptchaVerifier with the Firebase Auth instance and container element (not id).
      this.recaptchaVerifier = new RecaptchaVerifier(this.auth, this.recaptchaContainer.nativeElement, {
        'size': 'invisible', // Set to invisible to avoid user interaction initially.
        callback: (response: { credential: string }) => {
          // Callback function when reCAPTCHA is successfully solved.
          console.log('Recaptcha solved:', response);
          // If the current authentication method is phone and the verification code hasn't been sent,
          // proceed to send the SMS.
          if (this.currentAuthMethod === 'phone' && !this.phoneVerificationSent) {
            this.sendPhoneVerificationCode();
          }
        },
        'expired-callback': () => {
          // Callback function when the reCAPTCHA response expires.
          // Notify the user to solve reCAPTCHA again.
          this.showSnackbar(this.translate.instant('LOGIN.RECAPTCHA_EXPIRED'), SnackBarType.warning);
        }
      });
      // Render the reCAPTCHA widget.
      this.recaptchaVerifier.render();
    } else {
      console.warn('Recaptcha container element not found. Recaptcha will not be initialized.');
    }
  }

  /**
   * Debounce login button to prevent rapid submissions.
   */
  private loginInProgress = false;

  /**
   * @description Handles the login process, determining whether the user is
   * attempting to log in with email/password.
   * Removed phone login path from here as it's not fully implemented.
   */
  public async login(): Promise<void> {
    if (this.loginInProgress) return;
    this.loginInProgress = true;
    this.errorMessage = ''; // Clear any previous error messages.
    const identifier = this.loginForm.get('identifier')?.value;
    const password = this.loginForm.get('password')?.value;

    try {
      this.currentAuthMethod = 'email';
      this.loading.email = true;

      // signInByIdentifier auto-detects email / phone / username
      this.authService
        .signInByIdentifier(identifier, password)
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: async (response) => {
            if (response.user) {
              try {
                await this.finishLogin(response.user, 'password');
              } catch (error) {
                this.handleError(error, 'login:identifier', 'email');
              }
            }
          },
          error: async (error) => {
            if (await this.handleMfaRequired(error, 'password')) {
              return;
            }
            this.handleError(error, 'login:identifier', 'email');
            this.handleAccountExistsError(error, 'password');
            this.loading.email = false;
            this.loginInProgress = false;
          },
          complete: () => {
            this.loading.email = false;
            this.loginInProgress = false;
          }
        });
    } catch (error) {
      this.handleError(error, 'login:identifier', 'email');
      this.loading.email = false;
      this.loginInProgress = false;
    }
  }

  /**
   * @description Initiates the Google login process.
   * Uses Firebase's GoogleAuthProvider to sign in with a popup.
   */
  /**
   * @description Signs in with an enrolled passkey.
   *
   * Firebase has no passkey provider, so the server verifies the assertion and returns a
   * custom token — that exchange is what turns a WebAuthn assertion into a session. The
   * re-entry guard is here rather than on the button because a second click while a prompt
   * is open would start a second ceremony.
   */
  public async loginWithPasskey(): Promise<void> {
    if (this.loginInProgress) return;

    if (!isPlatformBrowser(this.platformId)) {
      console.warn('Passkey sign-in not available during SSR');
      return;
    }

    this.loginInProgress = true;
    this.errorMessage = '';

    try {
      const { verified, customToken } = await this.webAuthnService.authenticateWithPasskey();
      if (!verified || !customToken) {
        this.errorMessage = this.webAuthnService.error() || this.translate.instant('LOGIN.PASSKEY_FAILED');
        return;
      }

      const response = await this.firestoreService.signInWithCustomToken(customToken);
      await this.handleSocialLoginSuccess(response?.user || null, 'passkey');
    } catch (error) {
      this.handleError(error, 'login:passkey', 'passkey');
    } finally {
      this.loginInProgress = false;
    }
  }

  public async loginWithGoogle(): Promise<void> {
    if (this.loginInProgress) return;
    
    // Check if running in browser environment
    if (!isPlatformBrowser(this.platformId)) {
      console.warn('Google sign-in not available during SSR');
      return;
    }
    
    this.loginInProgress = true;
    this.loading.google = true; // Set loading state for Google login.
    this.errorMessage = ''; // Clear any previous error messages.

    try {
      // Use the AuthService to handle Google sign-in.
      this.authService.signInWithGoogle(this.googleProvider)
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: async (response) => {
            await this.handleSocialLoginSuccess(response?.user || null, 'google.com')
          },
          error: async (error) => {
            if (await this.handleMfaRequired(error, 'google.com')) {
              return;
            }

            if (this.shouldFallbackToRedirect(error)) {
              try {
                await this.authService.signInWithRedirectProvider(this.googleProvider);
                return;
              } catch (redirectError) {
                this.handleError(redirectError, 'login:google:redirect-fallback', 'google.com');
                return;
              }
            }

            this.handleError(error, 'login:google', 'google.com');
            this.handleAccountExistsError(error, 'google.com');
            this.cdr.detectChanges();
            this.loading.google = false;
            this.loginInProgress = false;
          },
          complete: () => {
            this.loading.google = false; // Always reset loading state on completion.
            this.loginInProgress = false;
          }
        });
    } catch (error) {
      this.handleError(error, 'login:google', 'google.com');
      this.loading.google = false;
      this.loginInProgress = false;
    }
  }

  /**
   * @description Initiates the GitHub login process.
   * Uses Firebase's GithubAuthProvider to sign in with a popup.
   */
  public async loginWithGithub(): Promise<void> {
    if (this.loginInProgress) return;
    
    // Check if running in browser environment
    if (!isPlatformBrowser(this.platformId)) {
      console.warn('GitHub sign-in not available during SSR');
      return;
    }
    
    this.loginInProgress = true;
    this.loading.github = true; // Set loading state for GitHub login.
    this.errorMessage = ''; // Clear any previous error messages.

    try {
      // Use the AuthService to handle GitHub sign-in.
      this.authService.signInWithGitHub(this.githubProvider)
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: async (response) => {
            await this.handleSocialLoginSuccess(response?.user || null, 'github.com')
          },
          error: async (error) => {
            if (await this.handleMfaRequired(error, 'github.com')) {
              return;
            }

            if (this.shouldFallbackToRedirect(error)) {
              try {
                await this.authService.signInWithRedirectProvider(this.githubProvider);
                return;
              } catch (redirectError) {
                this.handleError(redirectError, 'login:github:redirect-fallback', 'github.com');
                return;
              }
            }

            this.handleError(error, 'login:github', 'github.com');
            this.handleAccountExistsError(error, 'github.com');
            this.loading.github = false;
            this.loginInProgress = false;
          },
          complete: () => {
            this.loading.github = false; // Always reset loading state on completion.
            this.loginInProgress = false;
          }
        });
    } catch (error) {
      this.handleError(error, 'login:github', 'github.com');
      this.loading.github = false;
      this.loginInProgress = false;
    }
  }

  private async handleSocialLoginSuccess(user: User | null, providerId: string): Promise<void> {
    if (!user) {
      await this.trackLoginAttempt(providerId, false)
      this.errorMessage = this.translate.instant('AUTH_ERRORS.USER_NULL_AFTER_SIGNIN')
      this.showSnackbar(this.errorMessage, SnackBarType.error, '', 5000)
      return
    }

    try {
      await this.finishLogin(user, providerId)
    } catch (error) {
      this.handleError(error, `login:${providerId}`, providerId)
    }
  }

  /**
   * @description Handles the Firebase 'auth/account-exists-with-different-credential' error.
   * Displays a warning message to the user, prompting them to link their accounts.
   * @param {any} error - The error object returned by Firebase authentication.
   * @param {string} providerId - The ID of the provider that caused the error (e.g., 'google.com', 'github.com').
   */
  private handleAccountExistsError(error: MultiFactorError, providerId: string): void {
    const errorCode: string = error?.code as string;

    if (errorCode === 'auth/account-exists-with-different-credential') {
      // The original code tried to extract and use the credential directly, which is generally not
      // recommended for direct handling in the frontend due to security implications and complexity.
      // Instead, we rely on the `getErrorMessage` utility to provide a user-friendly message.
      this.errorMessage = getErrorMessage(error, this.translate);
      this.showSnackbar(this.errorMessage, SnackBarType.warning, '', 7000);
    }
  }

  /**
   * @description Attempts to link a pending credential with an existing user account.
   * This is typically used when a user tries to sign in with a new provider,
   * but their email already exists with a different provider.
   * @param {User} user - The Firebase User object to link the credential to.
   * @returns {Promise<UserCredential | null>} A promise that resolves with the UserCredential
   *   if linking is successful, or `null` if no pending credential or an error occurs.
   */
  private async handlePendingCredentialLinking(user: User): Promise<UserCredential | null> {
    if (!this.pendingCredential) {
      return null; // No pending credential to link.
    }

    try {
      // Link the user with the stored pending credential.
      const usercredential = await linkWithCredential(user, this.pendingCredential);
      // this.showSnackbar('Account successfully linked!', SnackBarType.success, '', 3000); // Optional success message.
      this.pendingCredential = null; // Clear the pending credential after successful linking.
      return usercredential;
    } catch (error: unknown) {
      console.error('Error linking account:', error);
      this.errorMessage = getErrorMessage(error, this.translate);
      // this.showSnackbar(`Error linking account: ${this.errorMessage}`, SnackBarType.error, '', 5000); // Optional error message.
      this.pendingCredential = null; // Clear the pending credential even on error to prevent re-attempts.
      return null; // Return null to indicate that linking failed.
    }
  }

  /**
   * @description Extracts a Firebase authentication error code from a raw error object or string.
   * This method ensures that the error object consistently has a `code` property.
   * @param {unknown} error - The raw error object or string.
   * @returns {{ code: string; message?: string }} The normalized error object with a `code` property.
   */
  private extractFirebaseError(error: MultiFactorError | string): { code: string; message?: string } {
    // If the error is a string and contains 'auth/', attempt to parse the error code.
    if (typeof error === 'string') {
      console.warn('Extracted Firebase error code:', error);
      const match = error.match(/auth\/([^)]+)/); // Regex to find the code.
      if (match && match[1]) {
        // Return a new error object with the extracted code and original message.
        return { code: match[1], message: error };
      }
      return { code: 'unknown_auth_error', message: error };
    }
    // For MultiFactorError object
    if (error && typeof error === 'object' && 'code' in error) {
      return { code: (error as any).code || 'unknown_error', message: (error as any).message };
    }
    return { code: 'unknown_error', message: String(error) };
  }

  /**
   * @description Returns the appropriate Firebase Auth provider based on the provider ID.
   * @param {string} providerId - The ID of the authentication provider (e.g., 'google.com', 'github.com').
   * @returns {typeof GoogleAuthProvider | typeof GithubAuthProvider | null} The Firebase Auth provider class or `null` if not found.
   */
  private getProvider(providerId: string): typeof GoogleAuthProvider | typeof GithubAuthProvider | null {
    switch (providerId) {
      case GoogleAuthProvider.PROVIDER_ID:
        return GoogleAuthProvider;
      case GithubAuthProvider.PROVIDER_ID:
        return GithubAuthProvider;
      // Add other providers as needed.
      default:
        return null;
    }
  }

  /**
   * @description Sends a phone verification code to the provided phone number.
   * This method uses Firebase PhoneAuthProvider and reCAPTCHA for verification.
   */
  public async sendPhoneVerificationCode(): Promise<void> {
    this.loading.phone = true; // Set loading state for phone verification.
    this.errorMessage = ''; // Clear any previous error messages.
    try {
      const phoneNumber = this.loginForm.get('identifier')?.value;
      if (!phoneNumber) {
        throw new Error('Phone number is required.');
      }
      // Use AuthService to send the phone verification code.
      this.confirmationResult = await this.authService.signInWithPhone(phoneNumber, this.recaptchaVerifier);
      this.phoneVerificationSent = true; // Indicate that the code has been sent.
      this.showSnackbar(this.translate.instant('AUTH_ERRORS.PHONE_VERIFICATION_SENT'), SnackBarType.success);
    } catch (error: unknown) {
      this.handleError(error, 'sendPhoneVerificationCode', 'phone');
      this.cdr.detectChanges();
      this.resetAuthFlow();
    } finally {
      this.loading.phone = false; // Always reset loading state.
    }
  }

  /**
   * @description Verifies the phone number using the code sent via SMS.
   * This is the second step in the phone authentication flow.
   */
  public async verifyPhoneNumberCode(): Promise<void> {
    this.loading.code = true; // Set loading state for code verification.
    this.errorMessage = ''; // Clear any previous error messages.
    try {
      // Assuming 'verificationCode' control exists if phone login is active.
      // If not, this part needs to be guarded or modified.
      const verificationCode = this.loginForm.get('verificationCode')?.value;
      if (!verificationCode) {
        throw new Error('Verification code is required.');
      }
      // Use AuthService to verify the phone code.
      const userCredential = await this.authService.verifyPhoneCode(this.confirmationResult.verificationId, verificationCode);

      // If user credential is valid, proceed with post-verification actions.
      if (userCredential.user) {
        if (!userCredential.user.phoneNumber) {
          await this.trackLoginAttempt('phone', false);
          this.showSnackbar(this.translate.instant('AUTH_ERRORS.PHONE_NUMBER_NOT_FOUND'), SnackBarType.error, '', 5000);
          this.resetAuthFlow();
          return;
        }

        await this.finishLogin(userCredential.user, 'phone');
      } else {
        await this.trackLoginAttempt('phone', false);
        this.errorMessage = this.translate.instant('AUTH_ERRORS.USER_NULL_AFTER_PHONE_VERIFICATION');
        this.showSnackbar(this.errorMessage, SnackBarType.error, '', 5000);
        this.resetAuthFlow();
      }
    } catch (error: unknown) {
      this.handleError(error, 'verifyPhoneNumberCode', 'code');
      this.cdr.detectChanges();
      this.resetAuthFlow();
    } finally {
      this.loading.code = false; // Always reset loading state.
    }
  }

  /**
   * @description Resets the phone authentication flow, clearing form, error messages,
   * and reCAPTCHA.
   */
  public resetAuthFlow(): void {
    this.currentAuthMethod = null;
    this.phoneVerificationSent = false;
    this.loginForm.reset(); // Reset form fields.
    this.errorMessage = ''; // Clear error message.

    this.recaptchaVerifier?.clear(); // Clear reCAPTCHA state.
    this.recaptchaVerifier?.render(); // Re-render reCAPTCHA for the next attempt.
  }

  /**
   * @description Performs post-login updates to user data in Firestore and handles
   * redirection if the user's email or phone is not verified.
   * @param {Pick<loginCredentials, 'user'>} response - The login response containing the Firebase User object.
   * @param {string} providerId - The ID of the authentication provider.
   * @returns {Promise<boolean>} A promise that resolves to `true` if the user is verified and can proceed, `false` otherwise.
   */
  private async onLoginUpdate(response: Pick<loginCredentials, 'user'>, providerId: string): Promise<boolean> {
    const userData = await this.firestoreService.getUserData(response.user.uid);

    // If no user data is found, something went wrong, prevent further processing.
    if (!userData) return false;

    let updateUser = false; // Flag to determine if user data needs to be updated.

    // Update email verification status if it has changed in Firebase.
    if (!userData.emailVerified && response.user.emailVerified) {
      userData.emailVerified = true;
      updateUser = true;
    }

    // Update providerId if the current login provider is different from the stored one.
    if (userData.providerId !== providerId) {
      updateUser = true;
    }

    // Store updated user data in Firestore if any changes were detected.
    if (updateUser) {
      await this.firestoreService.storeUserData(
        response.user,
        providerId || userData.providerId, // Use current providerId or existing if not provided.
        response.user.emailVerified,
        userData.username
      );
    }

    const isPasswordProvider = providerId === 'password'
    const emailOk = !isPasswordProvider || response.user.emailVerified === true
    const phoneOk = userData.phoneVerified !== false

    // Redirect to verification page when required verification is pending.
    if (!emailOk || !phoneOk) {
      this.showSnackbar(
        'Your email or phone number is not verified. Please verify to proceed.',
        SnackBarType.warning,
        '',
        5000
      );
      const returnUrl = this.getReturnUrl();
      this.router.navigate(['/service/verification'], { queryParams: { returnUrl } });
      return false; // Indicate that verification is pending.
    }

    return true; // User is verified and can proceed.
  }

  /**
   * @description Lifecycle hook that is called when the component is destroyed.
   * Unsubscribes from all active subscriptions to prevent memory leaks and clears reCAPTCHA.
   */
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.recaptchaVerifier?.clear();
  }

  private getFriendlyAuthErrorMessage(error: unknown): string {
    const errorObj = error && typeof error === 'object' ? (error as any) : {};
    const explicitMessage = typeof errorObj?.message === 'string' ? errorObj.message.trim() : ''
    const normalizedMessage = explicitMessage.toLowerCase()
    const code = String(errorObj?.code || '').toLowerCase()

    if (
      code === 'auth/invalid-argument' ||
      normalizedMessage.includes('missing phoneenrollmentinfo') ||
      normalizedMessage.includes('phoneenrollmentinfo')
    ) {
      return 'SMS MFA must be enrolled before this authenticator app step can continue.'
    }

    if (explicitMessage && !code.startsWith('auth/')) {
      return explicitMessage
    }

    return getErrorMessage(error, this.translate)
  }

  private getReturnUrl(): string {
    return resolveSafeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'))
  }
}
