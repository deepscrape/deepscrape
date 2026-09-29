import { Component, OnInit, inject, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Auth, sendPasswordResetEmail } from '@angular/fire/auth';
import { getErrorMessage } from 'src/app/core/functions';
import { ORIGINS } from 'src/app/core/guards/host-routing.policy';
import { FirestoreService, ThemeService } from 'src/app/core/services';
import { AnimatedBgComponent } from 'src/app/shared/animated-bg/animated-bg.component';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { I18nService } from 'src/app/core/i18n';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, Subscription } from 'rxjs';

@Component({
    selector: 'app-resetpassword',
    imports: [
        CommonModule,
        ReactiveFormsModule,
        RouterModule,
        MatIconModule,
        MatProgressSpinnerModule,
        TranslateModule,
    ],
    templateUrl: './resetpassword.component.html',
    styleUrl: './resetpassword.component.scss'
})
export class ResetPasswordComponent implements OnInit {
    resetPasswordForm: FormGroup;
    loading = false;
    resetEmailSent = false;
    errorMessage = '';
    private destroyRef = inject(DestroyRef)
    private themePicker = inject(ThemeService)
    protected isDarkMode$: Observable<boolean> = this.themePicker.isDarkMode$;
    /** Marketing apex. The brand mark must resolve to the site, never to a subdomain. */
    protected readonly apexUrl: string = ORIGINS.marketing;
    private langChangeSubscription: Subscription;

    constructor(
        private fb: FormBuilder,
        private fireService: FirestoreService,
        private translate: TranslateService,
        private i18nService: I18nService,
    ) {
        this.resetPasswordForm = this.fb.group({
            email: ['', [Validators.required, Validators.email]]
        });
    }

    get email() {
        return this.resetPasswordForm.get('email');
    }

    ngOnInit(): void {
        this.translate.use(this.i18nService.currentLang());
        this.langChangeSubscription = this.i18nService.currentLang$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((lang) => {
                this.translate.use(lang);
            });
    }

    async resetPassword() {
        if (this.resetPasswordForm.valid) {
            this.loading = true;
            this.errorMessage = '';

            try {
                const email = this.resetPasswordForm.get('email')?.value;
                await this.fireService.sendPasswordResetEmail(email)

                this.resetEmailSent = true;
            } catch (error: any) {
                this.errorMessage = getErrorMessage(error, this.translate);
            } finally {
                this.loading = false;
            }
        }
    }

    // private getErrorMessage(error: any): string {
    //     switch (error.code) {
    //         case 'auth/user-not-found':
    //             return 'No user found with this email address.';
    //         case 'auth/invalid-email':
    //             return 'Invalid email address.';
    //         case 'auth/too-many-requests':
    //             return 'Too many reset attempts. Please try again later.';
    //         default:
    //             return 'An error occurred. Please try again.';
    //     }
    // }
    ngOnDestroy(): void {
        this.langChangeSubscription?.unsubscribe();
    }
}
