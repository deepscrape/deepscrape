import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CookieService } from 'ngx-cookie-service';
import { AppFooterComponent } from '../../layout/footer';
import { LandingSubheaderComponent } from '../../shared/landing-subheader/landing-subheader.component';
import { WindowToken } from '../../core/services/window.service';

@Component({
  selector: 'app-privacy',
  imports: [RouterLink, AppFooterComponent, LandingSubheaderComponent],
  templateUrl: './privacy.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PrivacyComponent {
  private readonly cookies = inject(CookieService);
  private readonly window = inject(WindowToken);

  /**
   * Withdrawal, GDPR Art. 7(3): withdrawing has to be as easy as giving, and until this
   * existed nothing could undo an answer — `CookieConsentComponent` hides itself the moment
   * the `consent` cookie exists.
   *
   * Deleting the cookie is the whole fix, because every gate fails closed without it:
   * `guestTracker` returns before it mints anything and the guest-fingerprint route writes
   * nothing. The analytics identifiers go with it so no part of the withdrawn consent
   * survives, and the reload brings the box back for a fresh choice.
   */
  protected changeChoices(): void {
    for (const name of ['consent', 'gid', 'aid']) {
      this.cookies.delete(name);
    }

    this.window.location.reload();
  }
}
