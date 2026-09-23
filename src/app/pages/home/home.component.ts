import { Component, OnInit, HostListener, inject, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { AsyncPipe, NgClass } from '@angular/common';
import { DOCUMENT } from '@angular/common';
import { themeStorageKey, ThemeToggleComponent, AnimatedBgComponent, LangPickerComponent } from 'src/app/shared';
import { FeaturesComponent, HeroComponent, LandingAgentComponent, LandingArchitectureComponent, LandingCodeDemoComponent, LandingPricingComponent, LandingSocialProofComponent, LandingUseCasesComponent, LandingFaqComponent } from 'src/app/layout/landpage';
import { AuthService, LocalStorage, ThemeService, WindowToken, ScrollService } from 'src/app/core/services';
import { AppFooterComponent } from 'src/app/layout/footer';
import { Observable } from 'rxjs';

@Component({
  selector: 'app-home',
  imports: [
    RouterLink,
    ThemeToggleComponent,
    HeroComponent,
    LandingAgentComponent,
    FeaturesComponent,
    LandingArchitectureComponent,
    LandingCodeDemoComponent,
    LandingPricingComponent,
    LandingSocialProofComponent,
    LandingUseCasesComponent,
    LandingFaqComponent,
    AppFooterComponent,
    NgClass,
    AsyncPipe,
    AnimatedBgComponent,
    LangPickerComponent,
    TranslateModule
  ],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class HomeComponent implements OnInit {
  private localStorage = inject(LocalStorage);
  private themePicker = inject(ThemeService);
  private window: Window = inject(WindowToken);
  private scrollService = inject(ScrollService);
  private document = inject(DOCUMENT);
  isDarkMode$: Observable<boolean> = this.themePicker.isDarkMode$;
  /** Signed-in user, or null for guests — the header hides the dashboard link for them. */
  readonly user$ = inject(AuthService).user$;
  isScrolled = false;
  footerColor: string = '';
  // Removed 'lang' property as I18nService does not have it.

  readonly navLinks = [
    { id: 'agent', label: 'HOME.AGENT' },
    { id: 'features', label: 'HOME.FEATURES' },
    { id: 'use-cases', label: 'HOME.USE_CASES' },
    { id: 'architecture', label: 'HOME.ARCHITECTURE' },
    { id: 'pricing', label: 'HOME.PRICING' },
    { id: 'faq', label: 'HOME.FAQ' },
  ];

  constructor() {}

  @HostListener('window:scroll', [])
  onWindowScroll() {
    this.isScrolled = this.window.scrollY > 100;
  }

  /** Scrolls to a section anchor on this page (smooth, header-offset aware). */
  scrollToSection(id: string) {
    const el = this.document.getElementById(id);
    if (el) this.scrollService.scrollToElementByOffset(el);
  }

  isThemeDark(): boolean {
    const stored = this.localStorage?.getItem(themeStorageKey);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
    return this.window?.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
  }

  ngOnInit() {
    this.footerColor = 'landpage';
  }
}
