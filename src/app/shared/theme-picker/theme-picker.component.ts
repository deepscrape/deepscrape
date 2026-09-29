import { isPlatformBrowser } from '@angular/common';
import { Component, Inject, OnDestroy, PLATFORM_ID, WritableSignal, inject, input, signal, DOCUMENT } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { RippleDirective } from 'src/app/core/directives/ripple.directive';
import { AppTheme } from 'src/app/core/enum';
import { browserProvider, BrowserToken } from 'src/app/core/services/browser.service';
import { LocalStorage, STORAGE_PROVIDERS } from 'src/app/core/services/storage.service';
import { windowProvider, WindowToken } from 'src/app/core/services/window.service';
import { ThemeService } from 'src/app/core/services/theme.service';

export const themeStorageKey = 'app-theme-dark';

@Component({
    selector: 'app-theme-toggle',
    templateUrl: './theme-picker.component.html',
    imports: [MatIcon, RippleDirective],
    providers: [{ provide: WindowToken, useFactory: windowProvider },
    { provide: BrowserToken, useFactory: browserProvider },
        STORAGE_PROVIDERS
    ]
})
export class ThemeToggleComponent {

    private window = inject(WindowToken)
    private storage = inject(LocalStorage)
    private themeService = inject(ThemeService);

    color = input<{ dark: string, light: string } | undefined>()


    isDark = false;
    mode: 'light' | 'dark' | 'system' = 'system';
    readonly options: Array<{ id: 'light' | 'dark' | 'system'; icon: string; label: string }> = [
        { id: 'light', icon: 'light_mode', label: 'Light mode' },
        { id: 'dark', icon: 'dark_mode', label: 'Dark mode' },
        { id: 'system', icon: 'desktop_windows', label: 'System theme' },
    ];
    private storedPreference: AppTheme | undefined = undefined;
    private currentTheme: WritableSignal<AppTheme | undefined>;
    private systemQuery: MediaQueryList | null = null;
    private readonly onSystemChange = (): void => {
        this.isDark = this.isSystemDark();
        this.setSystemTheme();
    }

    constructor(@Inject(DOCUMENT) private document: Document,
        @Inject(PLATFORM_ID) private platformId: object) {
        this.initializeThemeFromPreferences();
    }

    selectTheme(mode: 'light' | 'dark' | 'system'): void {
        this.mode = mode;
        if (mode === 'system') {
            this.attachSystemListener();
            return;
        }
        this.detachSystemListener();
        this.isDark = mode === 'dark';
        this.themeService.setDarkMode(this.isDark);
        this.updateRenderedTheme();
    }

    // Called once on app boot to make sure the applied theme matches the saved
    // preference. For system mode this keeps following the OS (no storage write).
    setDefaultTheme(): void {
        if (this.mode === 'system') {
            this.attachSystemListener();
        } else {
            this.updateRenderedTheme();
        }
    }

    ngOnDestroy(): void {
        this.detachSystemListener();
    }

    private attachSystemListener(): void {
        if (!isPlatformBrowser(this.platformId)) return;
        this.detachSystemListener();
        this.systemQuery = this.window.matchMedia('(prefers-color-scheme: dark)');
        this.systemQuery.addEventListener('change', this.onSystemChange);
        this.isDark = this.systemQuery.matches;
        this.themeService.setDarkMode(this.isDark);
        this.setSystemTheme();
    }

    private detachSystemListener(): void {
        this.systemQuery?.removeEventListener('change', this.onSystemChange);
        this.systemQuery = null;
    }

    private initializeThemeFromPreferences(): void {

        // Check whether there's an explicit preference in localStorage.
        this.storedPreference = this.storage ? this.storage?.getItem(themeStorageKey) as AppTheme || undefined : undefined

        this.currentTheme = signal<AppTheme | undefined>(this.storedPreference)


        // If we do have a preference in localStorage, use that. Otherwise,
        // follow the OS colour scheme (system theme).
        if (this.storedPreference) {
            this.isDark = this.storedPreference === 'true';
            this.mode = this.isDark ? 'dark' : 'light';
            this.updateRenderedTheme();
        } else {
            this.mode = 'system';
            this.attachSystemListener();
        }


        /*  const initialTheme = this.document.querySelector('#ai-initial-theme');
         if (initialTheme) {
             // TODO: change to initialTheme.remove() when ie support is dropped
             initialTheme.parentElement?.removeChild(initialTheme);
         }
  */
        /* const themeLink = this.document.createElement('link')
        themeLink.id = 'ai-custom-theme';
        themeLink.rel = 'stylesheet';
        themeLink.href = `${this.getThemeName()}-theme.css`;
        this.document.head.appendChild(themeLink); */


    }

    private updateRenderedTheme(): void {
        // If we're calling this method, the user has explicitly interacted with the theme toggle.
        /* const customLinkElement = this.document.getElementById('ai-custom-theme') as HTMLLinkElement | null;
        if (customLinkElement) {
            customLinkElement.href = `${this.getThemeName()}-theme.css`;
        } */

        /* if (this.isSystemDark()) {
            this.setSystemTheme()
        } */
        if (this.isDark) {
            this.setDarkTheme()
        } else {
            this.setLightTheme()
        }

        // this.setToLocalStorage(String(this.isDark) as AppTheme)

    }

    setLightTheme() {

        this.currentTheme.set(AppTheme.LIGHT);
        this.setToLocalStorage(AppTheme.LIGHT);
        this.removeClassFromHtml('dark');
    }
    setDarkTheme() {
        this.currentTheme.set(AppTheme.DARK);
        this.setToLocalStorage(AppTheme.DARK);
        this.addClassToHtml('dark')
    }
    setSystemTheme() {
        this.currentTheme.set(AppTheme.SYSTEM)
        this.removeFromLocalStorage()

        if (this.isSystemDark()) {
            this.addClassToHtml('dark')
        } else {
            this.removeClassFromHtml('dark')
        }
    }

    isSystemDark() {
        return isPlatformBrowser(this.platformId) ? this.window.matchMedia('(prefers-color-scheme: dark)')?.matches ?? false : false
    }

    private addClassToHtml(className: string) {

        this.removeClassFromHtml(className);
        this.document.documentElement.classList.add(className)

    }
    private removeClassFromHtml(className: string) {

        this.document.documentElement.classList.remove(className)

    }
    private setToLocalStorage(theme: AppTheme) {

        this.storage?.setItem(themeStorageKey, theme);

    }
    private removeFromLocalStorage() {

        this.storage?.removeItem(themeStorageKey);

    }
}
