import { AsyncPipe } from '@angular/common';
import {
  Component,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { ChildrenOutletContexts, RouterOutlet } from '@angular/router';
import { Observable } from 'rxjs/internal/Observable';
import { fadeInOutAnimation } from 'src/app/animations';
import { ORIGINS } from 'src/app/core/guards/host-routing.policy';
import { LocalStorage, ThemeService, WindowToken } from 'src/app/core/services';
import { LangPickerComponent } from 'src/app/shared/lang-picker/lang-picker.component';
import { NotificationBellComponent } from 'src/app/shared/notification-bell/notification-bell.component';
import { themeStorageKey, ThemeToggleComponent } from 'src/app/shared/theme-picker/theme-picker.component';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-service-layout',
  imports: [RouterOutlet, ThemeToggleComponent, NotificationBellComponent, AsyncPipe,
    LangPickerComponent
  ],
  templateUrl: './app-service-layout.component.html',
  styleUrl: './app-service-layout.component.scss',
  animations: [fadeInOutAnimation]
})
export class AppServiceLayoutComponent {

  private localStorage = inject(LocalStorage)
  private themePicker = inject(ThemeService)
  private window = inject(WindowToken)
  isDarkMode$: Observable<boolean> = this.themePicker.isDarkMode$

  /** Marketing apex. The brand mark must resolve to the site, never to a subdomain. */
  // ponytail: was ORIGINS.marketing. An unconditional hop to the apex put the landing page
  // one logo-click away from the app and console origins. These pages are PRERENDERED and
  // served from all three hosts, so `window.location.hostname` does not exist at render time
  // and the origin has to be named. The app origin is named rather than the apex, so the logo
  // never leads back to marketing.
  protected readonly homeUrl: string = ORIGINS.app + '/dashboard';

  constructor(private contexts: ChildrenOutletContexts) { }
  getAnimationData(outlet: RouterOutlet) {
    return this.contexts.getContext('primary')?.route?.snapshot?.data?.['animation']
    // return outlet && outlet.activatedRouteData && outlet.activatedRouteData['animation']
  }

  themeIsDark() {
    const stored = this.localStorage?.getItem(themeStorageKey);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
    return this.window?.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
  }

}
