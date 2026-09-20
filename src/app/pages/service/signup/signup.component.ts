import { Component, OnInit, OnDestroy, AfterViewInit, inject, DestroyRef, ViewChild, ElementRef, PLATFORM_ID, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { AbstractControl, FormBuilder, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Auth, GoogleAuthProvider, createUserWithEmailAndPassword, signInWithPopup, User, UserCredential, sendEmailVerification, verifyBeforeUpdateEmail, updateProfile, updatePhoneNumber, fetchSignInMethodsForEmail, linkWithCredential, GithubAuthProvider, OAuthProvider, RecaptchaVerifier, ActionCodeSettings } from '@angular/fire/auth';
import { Firestore, doc, setDoc } from '@angular/fire/firestore';
import { Users, Loading } from 'src/app/core/types';
import { checkPasswordStrength, getErrorMessage } from 'src/app/core/functions';
import { FirestoreService, SnackbarService, AuthService, ThemeService, WindowToken, AnalyticsService } from 'src/app/core/services';
import { DEFAULT_PROFILE_URL } from 'src/app/core/variables';
import { createPasswordStrengthValidator } from 'src/app/core/directives';
import { SnackBarType } from 'src/app/core/components';
import { Observable, Subscription } from 'rxjs';
import { CookieService } from 'ngx-cookie-service'; // Import CookieService
import { AnimatedBgComponent } from 'src/app/shared';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { I18nService } from 'src/app/core/i18n';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CheckboxComponent } from 'src/app/core/components';

// First, create an interface for your form structure
interface SignupForm {
    name: FormControl<string | null>;
    email: FormControl<string | null>;
    password: FormControl<string | null>;
    confirmPassword: FormControl<string | null>;
    phoneNumber: FormControl<string | null>;
    terms: FormControl<boolean>;
}

@Component({
    selector: 'app-signup',
    imports: [
        CommonModule,
        ReactiveFormsModule,
        RouterModule,
        MatIconModule,
        MatProgressSpinnerModule,
        TranslateModule,
        CheckboxComponent,
    ],
    templateUrl: './signup.component.html',
    styleUrl: './signup.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SignupComponent implements OnInit, OnDestroy, AfterViewInit {
    @ViewChild('recaptchaContainer', { static: false }) recaptchaContainer!: ElementRef<HTMLDivElement>;
    /** Instance of Firebase RecaptchaVerifier for phone authentication. */
    public recaptchaVerifier!: RecaptchaVerifier;
    private window = inject(WindowToken)
    private platformId = inject<Object>(PLATFORM_ID)
    private analytics = inject(AnalyticsService)
    signupForm: FormGroup
    emailCheckSubs: Subscription
    loading: Loading = {
        github: false,
        logout: false,
        google: false,
        email: false,
        remove: false,
        phone: false,
        code: false,
        password: false,
        mfa: false,

    };
    errorMessage = '';
    private themePicker = inject(ThemeService);
    protected isDarkMode$: Observable<boolean> = this.themePicker.isDarkMode$;
    private destroyRef = inject(DestroyRef);
    private langChangeSubscription: Subscription;
    public currentAuthMethod: 'email' | 'phone' | null = null;
    public phoneVerificationSent: boolean = false;
    confirmationResult: any;

    private mapSignupError(error: unknown): string {
        const errorObj = error as { code?: string; message?: string } | null;
        const code = String(errorObj?.code || '').toLowerCase();
        const message = String(errorObj?.message || '').toUpperCase();

        if (code.includes('admin-restricted-operation') || message.includes('ADMIN_ONLY_OPERATION')) {
            return 'Password sign-up is disabled for public users. Preapproved admin emails can continue through the secure bootstrap flow.';
        }

        return getErrorMessage(error, this.translate);
    }

    private isAdminRestrictedSignupError(error: unknown): boolean {
        const errorObj = error as { code?: string; message?: string } | null;
        const code = String(errorObj?.code || '').toLowerCase();
        const message = String(errorObj?.message || '').toUpperCase();

        return code.includes('admin-restricted-operation') || message.includes('ADMIN_ONLY_OPERATION');
    }

    private async finalizePasswordSignup(userCredential: UserCredential, name: string | null | undefined, phoneNumber: string | null | undefined): Promise<void> {
        const actionCodeSettings: ActionCodeSettings = {
            url: `${this.window.location.origin}/service/verification?mode=verifyEmail`,
        }

        console.log('📧 Sending email verification with actionCodeSettings:', actionCodeSettings);
        await sendEmailVerification(userCredential.user, actionCodeSettings)

        if (userCredential.user) {
            await updateProfile(userCredential.user, {
                displayName: name || userCredential.user.email?.split('@')[0] || '',
                photoURL: DEFAULT_PROFILE_URL,
            })

            await this.firestoreService.storeUserData(userCredential.user, 'password', false, null, phoneNumber ? false : null)

            // The conversion is the persisted account, not the form submit. Email
            // verification happens afterwards on another route, so this is the only
            // funnel step the signup page owns.
            this.analytics.trackEvent('signup_completed', { method: 'password' })
                .subscribe({ error: () => undefined })

            const navigationState: any = { email: userCredential.user.email };
            if (phoneNumber) {
                navigationState.phoneNumber = phoneNumber;
            }

            this.loading.email = false;
            this.router.navigate(['/service/verification'], { state: navigationState });
        }
    }

    private async bootstrapAdminPasswordSignup(email: string, password: string, name: string | null | undefined, phoneNumber: string | null | undefined): Promise<void> {
        await this.authService.createBootstrapAdminPasswordAccount(email, password, name || '')
        const userCredential = await this.firestoreService.signInWithEmailAndPassword(email, password)
        await this.finalizePasswordSignup(userCredential, name, phoneNumber)
    }

    constructor(
        private fb: FormBuilder,
        private auth: Auth,
        private firestore: Firestore,
        private router: Router,
        private firestoreService: FirestoreService,
        private snackbarService: SnackbarService,
        private authService: AuthService, // Inject AuthService
        private cookieService: CookieService, // Inject CookieService
        private translate: TranslateService, // Inject TranslateService
        private i18nService: I18nService, // Inject I18nService
    ) {
    }


    /**
     * Consent control. Held as a field as well as in the group because
     * `<app-checkbox>` binds a `FormControl` directly instead of taking a
     * `formControlName`; `nonNullable` keeps its type `FormControl<boolean>`.
     */
    readonly termsControl = new FormControl(false, {
        nonNullable: true,
        validators: [Validators.requiredTrue]
    });

    ngOnInit(): void {
        this.translate.use(this.i18nService.currentLang());
        this.langChangeSubscription = this.i18nService.currentLang$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((lang) => {
                this.translate.use(lang);
            });
        this.signupForm = this.fb.group<SignupForm>({
            name: this.fb.control('', {
                validators: [Validators.required, Validators.minLength(2)],
                nonNullable: false
            }),
            email: this.fb.control('', {
                validators: [Validators.required, Validators.email],
                nonNullable: false
            }),
            password: this.fb.control('', {
                validators: [
                    Validators.required,
                    Validators.minLength(8),
                    createPasswordStrengthValidator(),
                ],
                updateOn: 'blur',
                nonNullable: false
            }),
            confirmPassword: this.fb.control('', {
                validators: [Validators.required],
                nonNullable: false
            }),
            phoneNumber: this.fb.control('', {
                validators: [Validators.pattern(/^\+?[1-9]\d{1,14}$/)],
                nonNullable: false
            }),
            // Consent has to be a deliberate act, so this is a real control with
            // `requiredTrue` rather than a decorative link — the submit button is
            // bound to `signupForm.valid`, so it stays disabled until it is
            // checked. `signup()` destructures only email/confirmPassword/name/
            // phoneNumber, so this never reaches the create-user payload.
            terms: this.termsControl,
        }, {
            validators: this.passwordMatchValidator
        });
    }

    /**
   * @description Lifecycle hook that is called after Angular has fully initialized a component's view.
   * Placeholder for any view-related initialization.
   */
    ngAfterViewInit(): void {
        // Recaptcha initialization might be placed here if it depends on DOM elements being present.
        if (!isPlatformBrowser(this.platformId)) {
            return;
        }
        this.initializeRecaptcha()
    }

    /**
       * @description Initializes the Firebase reCAPTCHA verifier for phone authentication.
       * This is crucial for preventing abuse of the phone sign-in flow.
       */
    private initializeRecaptcha(): void {
        if (!isPlatformBrowser(this.platformId)) {
            return;
        }
        // Check if the reCAPTCHA container element exists in the DOM.
        if (this.recaptchaContainer && this.recaptchaContainer.nativeElement) {
            // Initialize RecaptchaVerifier with the Firebase Auth instance and container element (not id).
            this.recaptchaVerifier = new RecaptchaVerifier(this.auth, this.recaptchaContainer.nativeElement, {
                'size': 'invisible', // Set to invisible to avoid user interaction initially.
                callback: (response: any) => {
                    // Callback function when reCAPTCHA is successfully solved.
                    console.log('Recaptcha solved:', response);
                    // If the current register has is phone and the verification code hasn't been sent,
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
 * @description Sends a phone verification code to the provided phone number.
 * This method uses Firebase PhoneAuthProvider and reCAPTCHA for verification.
 */
    public async sendPhoneVerificationCode(): Promise<void> {
        this.loading.phone = true; // Set loading state for phone verification.
        this.errorMessage = ''; // Clear any previous error messages.
        try {
            const phoneNumber = this.signupForm.get('phoneNumber')?.value;
            if (!phoneNumber) {
                throw new Error('Phone number is required.');
            }
            // Use AuthService to send the phone verification code.
            this.confirmationResult = await this.authService.signInWithPhone(phoneNumber, this.recaptchaVerifier);
            this.phoneVerificationSent = true; // Indicate that the code has been sent.
            this.showSnackbar(this.translate.instant('AUTH_ERRORS.PHONE_VERIFICATION_SENT'), SnackBarType.success);
        } catch (error: any) {
            // this.handleError(error, 'sendPhoneVerificationCode', 'phone');
            // this.cdr.detectChanges();
            // this.resetAuthFlow();
        } finally {
            this.loading.phone = false; // Always reset loading state.
        }
    }

    passwordMatchValidator(control: AbstractControl): { [key: string]: any } | null {
        const form = control as FormGroup;
        const password = form.get('password');
        const confirmPassword = form.get('confirmPassword');

        if (password && confirmPassword && password.value !== confirmPassword.value) {
            confirmPassword.setErrors({ passwordMismatch: true });
            return { passwordMismatch: true };
        } else {
            if (confirmPassword?.hasError('passwordMismatch')) {
                confirmPassword.setErrors(null);
            }
            return null;
        }
    }


    protected checkPasswordStrength(password: string): string {

        return checkPasswordStrength(password, (k) => this.translate.instant(k))
    }

    async signup() {
        this.errorMessage = ''
        if (this.signupForm.valid) {
            this.loading.email = true
            const { email, confirmPassword, name, phoneNumber } = this.signupForm.value
            // Check if the email already exists
            this.emailCheckSubs = this.authService.checkUserEmailForDifferentProvider(email).subscribe({
                next: async (response) => {
                    try {
                        if (response.exists) {
                            this.errorMessage = this.translate.instant('SIGNUP.EMAIL_ALREADY_EXISTS')
                            this.showSnackbar(this.errorMessage, SnackBarType.error, '', 5000)
                            this.loading.email = false
                            return
                        }
                        try {
                            const userCredential = await createUserWithEmailAndPassword(this.auth, email, confirmPassword) as UserCredential
                            await this.finalizePasswordSignup(userCredential, name, phoneNumber)
                        } catch (signupError) {
                            if (this.isAdminRestrictedSignupError(signupError)) {
                                await this.bootstrapAdminPasswordSignup(email, confirmPassword, name, phoneNumber)
                                return
                            }

                            throw signupError
                        }
                    } catch (error: any) {
                        this.errorMessage = this.mapSignupError(error)
                        this.showSnackbar(this.errorMessage, SnackBarType.error, '', 5000)
                        this.loading.email = false
                    }
                },
                error: (error) => {
                    this.errorMessage = this.mapSignupError(error)
                    this.showSnackbar(this.errorMessage, SnackBarType.error, '', 5000)
                    this.loading.email = false
                }
            })
        }
    }

    // 'info' | 'success' | 'warning' | 'error'
    showSnackbar(
        message: string,
        type: SnackBarType = SnackBarType.info,
        action: string | '' = '',
        duration: number = 3000) {

        this.snackbarService.showSnackbar(message, type, action, duration)
    }

    ngOnDestroy(): void {
        //Called once, before the instance is destroyed.
        //Add 'implements OnDestroy' to the class.
        this.emailCheckSubs?.unsubscribe()
        this.langChangeSubscription?.unsubscribe();
    }
}
