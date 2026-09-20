import { AsyncPipe, CommonModule } from '@angular/common';
import {
  Component,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { ChildrenOutletContexts, RouterLink, RouterOutlet } from '@angular/router';
import { Observable } from 'rxjs/internal/Observable';
import { fadeInOutAnimation } from 'src/app/animations';
import { LocalStorage, ThemeService, WindowToken } from 'src/app/core/services';
import { LangPickerComponent, NotificationBellComponent, themeStorageKey, ThemeToggleComponent } from 'src/app/shared';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-service-layout',
  imports: [RouterOutlet, RouterLink, ThemeToggleComponent, NotificationBellComponent, AsyncPipe,
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
