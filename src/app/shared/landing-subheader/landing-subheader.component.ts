import { AsyncPipe, NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component, HostListener, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { ThemeService, WindowToken } from 'src/app/core/services';
import { ThemeToggleComponent } from '../theme-picker/theme-picker.component';
import { LangPickerComponent } from '../lang-picker/lang-picker.component';

interface SubNavItem {
  label: string;
  link: string;
}

/**
 * Landpage-style header reused by static pages that are not part of the main
 * landpage scroll chrome (privacy, terms, 404): brand logo + wordmark,
 * glass-on-scroll bar, glass-pill nav, theme/lang controls.
 */
@Component({
  selector: 'app-landing-subheader',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, ThemeToggleComponent, LangPickerComponent, AsyncPipe, NgClass],
  templateUrl: './landing-subheader.component.html',
  styleUrl: './landing-subheader.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LandingSubheaderComponent {
  private window: Window = inject(WindowToken);
  readonly isDarkMode$ = inject(ThemeService).isDarkMode$;
  isScrolled = false;

  /** Glass-on-scroll, same trigger as the landpage header. */
  @HostListener('window:scroll', [])
  onWindowScroll(): void {
    this.isScrolled = this.window.scrollY > 24;
  }

  readonly items: SubNavItem[] = [
    { label: 'Home', link: '/' },
    { label: 'Privacy', link: '/privacy' },
    { label: 'Terms', link: '/terms' },
    { label: 'Contact', link: '/contact' },
  ];
}
