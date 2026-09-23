import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  PLATFORM_ID,
  signal,
  viewChild,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { CookieService } from 'ngx-cookie-service';
import { TranslateModule } from '@ngx-translate/core';
import { COOKIE_INVENTORY } from './cookie-inventory';

/**
 * Consent box: one binary gate the server reads, plus two categories that act on real cookies.
 *
 * The choice has to reach the SERVER, not just the app: `guestTracker`
 * (`functions/src/gfunctions/analytics.ts`) mints a one-year `gid` cookie and a
 * `guests/{sha256(ip|user-agent|os|device)}` document, and it reads this cookie
 * to decide. A localStorage flag would be invisible to it — which is how the
 * site came to track every anonymous visitor while the privacy policy promised
 * analytics "with your consent".
 *
 * Rendered from `afterNextRender` so it never appears in SSR output: consent is
 * only knowable in the browser, so a server render would either flash the banner
 * at visitors who already answered or mismatch on hydration.
 */
@Component({
  selector: 'app-cookie-consent',
  imports: [TranslateModule, RouterLink],
  templateUrl: './cookie-consent.component.html',
  // `::backdrop` has no Tailwind variant in v3, so the scrim is one CSS rule.
  styles: ['dialog::backdrop { background: rgb(2 6 23 / 0.65); }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CookieConsentComponent {
  /** Mirrors `CONSENT_COOKIE` in `functions/src/domain/analytics-helpers.ts`. */
  private static readonly CONSENT_COOKIE = 'consent';
  private static readonly GRANTED = 'granted';
  private static readonly DENIED = 'denied';
  private static readonly CONSENT_DAYS = 365;

  /**
   * What each optional category owns. "Off" deletes these, which is what makes the
   * toggle real instead of cosmetic:
   * - `gid` / `aid` are the analytics identity cookies (`guestTracker` mints `gid`,
   *   `GuestTrackingService` writes `aid`). Deleting them stops the tracking the
   *   server would otherwise resume on the next request.
   * - `device_id` is the trusted-device cookie (`DeviceVerificationService`). Off
   *   means the verification email is asked for again, which is the honest cost of
   *   not being recognised.
   */
  private static readonly ANALYTICS_COOKIES = ['gid', 'aid'];
  private static readonly FUNCTIONAL_COOKIES = ['device_id'];

  private readonly cookies = inject(CookieService);
  private readonly http = inject(HttpClient);
  private readonly platformId = inject(PLATFORM_ID);

  /** Native modal, so the page behind it is inert until a choice is made. */
  private readonly sheet = viewChild<ElementRef<HTMLDialogElement>>('sheet');

  protected readonly visible = signal(false);
  protected readonly expanded = signal(false);

  /** Default off: consent is given, never assumed. */
  protected readonly analytics = signal(false);
  protected readonly functional = signal(false);

  /**
   * The cookies each switch actually owns, straight from the published inventory so
   * the banner cannot claim a different set than the policy does. Names and retention
   * only — the purposes are prose and stay in the policy.
   */
  protected readonly cookiesByCategory = {
    analytics: COOKIE_INVENTORY.filter((cookie) => cookie.category === 'analytics'),
    functional: COOKIE_INVENTORY.filter((cookie) => cookie.category === 'functional'),
    necessary: COOKIE_INVENTORY.filter((cookie) => cookie.category === 'necessary'),
  } as const;

  /** Driven by `@for` so the three rows cannot drift apart in the markup. */
  protected readonly categories = [
    { key: 'analytics', titleKey: 'COOKIE_CONSENT.ANALYTICS_TITLE', descKey: 'COOKIE_CONSENT.ANALYTICS_DESC' },
    { key: 'functional', titleKey: 'COOKIE_CONSENT.FUNCTIONAL_TITLE', descKey: 'COOKIE_CONSENT.FUNCTIONAL_DESC' },
  ] as const;

  constructor() {
    afterNextRender(() => {
      if (!isPlatformBrowser(this.platformId)) {
        return;
      }
      // Any recorded answer keeps the box away. 'denied' is an answer, not an
      // invitation to ask again on every page view.
      this.visible.set(!this.cookies.check(CookieConsentComponent.CONSENT_COOKIE));
    });

    // `showModal`, not `show`: the modal state is what makes the rest of the page
    // inert and traps focus in here. Nothing closes it — Esc is cancelled below and
    // a `<dialog>` ignores backdrop clicks — so the only way out is a decision.
    effect(() => {
      const dialog = this.sheet()?.nativeElement;
      if (dialog && this.visible() && !dialog.open) {
        dialog.showModal();
      }
    });
  }

  /** Esc must not be an unrecorded exit: closing without a choice would leave no answer. */
  protected blockDismiss(event: Event): void {
    event.preventDefault();
  }

  protected isOn(key: 'analytics' | 'functional'): boolean {
    return key === 'analytics' ? this.analytics() : this.functional();
  }

  protected toggle(key: 'analytics' | 'functional'): void {
    const target = key === 'analytics' ? this.analytics : this.functional;
    target.update((value) => !value);
  }

  protected acceptAll(): void {
    this.analytics.set(true);
    this.functional.set(true);
    this.commit();
  }

  /** "Necessary only" is a real refusal, so it clears both optional categories. */
  protected necessaryOnly(): void {
    this.analytics.set(false);
    this.functional.set(false);
    this.commit();
  }

  protected save(): void {
    this.commit();
  }

  /**
   * Records the choice.
   *
   * `ponytail:` one gate, one write. The `consent` cookie stays binary because it is
   * the only thing the server reads, so granular choices are expressed as the actions
   * taken here (which cookies survive) rather than as a preference record. Google
   * Analytics is initialised at bootstrap (`app.config.ts`), so a grant applies from
   * the next page load rather than mid-session.
   */
  private commit(): void {
    // Report the decision while it is still knowable. Aggregate only — the server keeps a
    // daily count, never an identifier — and it is the one number that survives the gate
    // this box is about to close. A lost count must never block the choice, hence the
    // swallowed error.
    this.http
      .post('/event/consent', { decision: this.analytics() ? 'granted' : 'denied' })
      .subscribe({ error: () => undefined });

    if (!this.analytics()) {
      this.drop(CookieConsentComponent.ANALYTICS_COOKIES);
    }
    if (!this.functional()) {
      this.drop(CookieConsentComponent.FUNCTIONAL_COOKIES);
    }

    this.cookies.set(
      CookieConsentComponent.CONSENT_COOKIE,
      this.analytics() ? CookieConsentComponent.GRANTED : CookieConsentComponent.DENIED,
      CookieConsentComponent.CONSENT_DAYS,
      '/',
      '',
      true,
      'Lax',
    );
    this.visible.set(false);
  }

  private drop(names: string[]): void {
    for (const name of names) {
      this.cookies.delete(name, '/');
    }
  }
}
