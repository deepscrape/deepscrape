import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  PLATFORM_ID,
} from '@angular/core';
import { CommonModule, AsyncPipe, isPlatformBrowser } from '@angular/common';
import {
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { TranslateModule } from '@ngx-translate/core';
import { finalize, firstValueFrom } from 'rxjs';
import { myIcons, LangPickerComponent, ThemeToggleComponent } from 'src/app/shared';
import { Observable } from 'rxjs/internal/Observable';
import { AnalyticsService, ThemeService } from 'src/app/core/services';
import { AppCheck, getLimitedUseToken } from '@angular/fire/app-check';

export interface ContactFormData {
  name: string;
  email: string;
  subject: string;
  message: string;
  source: string;
}

@Component({
  selector: 'app-contact',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    LucideAngularModule,
    TranslateModule,
    RouterLink,
    LangPickerComponent,
    ThemeToggleComponent,
    AsyncPipe,
  ],
  templateUrl: './contact.component.html',
  styleUrl: './contact.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContactComponent {
  private fb = inject(FormBuilder);
  private http = inject(HttpClient);
  private themeService = inject(ThemeService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly appCheck = inject(AppCheck, { optional: true });
  private readonly analytics = inject(AnalyticsService);

  readonly icons = myIcons;
  readonly isDarkMode$: Observable<boolean> = this.themeService.isDarkMode$;

  submitting = signal(false);
  success = signal(false);
  errorMessage = signal('');
  fieldErrors = signal<string[]>([]);

  contactForm: FormGroup = this.fb.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(100)]],
    email: ['', [Validators.required, Validators.email, Validators.maxLength(254)]],
    subject: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(200)]],
    message: ['', [Validators.required, Validators.minLength(10), Validators.maxLength(5000)]],
  });

  async onSubmit(): Promise<void> {
    if (this.contactForm.invalid) {
      this.contactForm.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.errorMessage.set('');
    this.fieldErrors.set([]);
    this.success.set(false);

    // Get Firebase App Check limited-use token and send via X-Firebase-AppCheck header
    // (per Firebase docs: https://firebase.google.com/docs/app-check/custom-resource-backend)
    let headers = new HttpHeaders();
    if (isPlatformBrowser(this.platformId) && this.appCheck) {
      try {
        const limitedUseToken = await getLimitedUseToken(this.appCheck);
        headers = headers.set('X-Firebase-AppCheck', limitedUseToken.token);
      } catch {
        console.warn('[contact] Failed to get App Check token — continuing without');
      }
    }

    const payload: ContactFormData = {
      ...this.contactForm.value,
      source: 'website',
    };

    firstValueFrom(
      this.http.post<{ success: boolean; message: string; errors?: string[]; id?: string }>(
        '/services/contact',
        payload,
        { headers },
      ).pipe(finalize(() => this.submitting.set(false)))
    ).then((res) => {
      if (res.success) {
        // A lead, not an attempt: the form posted and the backend accepted it.
        this.analytics.trackEvent('contact_submitted', { source: 'website' })
          .subscribe({ error: () => undefined })
        this.success.set(true);
        this.contactForm.reset();
      }
    }).catch((err) => {
      const body = err.error;
      if (body?.errors && Array.isArray(body.errors)) {
        this.fieldErrors.set(body.errors);
      }
      this.errorMessage.set(
        body?.message || 'An unexpected error occurred. Please try again.',
      );
    });
  }
}
