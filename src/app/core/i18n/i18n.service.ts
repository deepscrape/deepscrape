import { Injectable, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Observable } from 'rxjs';

import { WindowToken } from '../services/window.service';

// Available locale files under src/assets/i18n — keep in sync with them.
export const SUPPORTED_LANGS = ['en', 'el', 'es', 'fr', 'de'];

/** localStorage key holding the language the user picked. */
const LANG_STORAGE_KEY = 'app-lang';

@Injectable({
  providedIn: 'root',
})
export class I18nService {
  private translate = inject(TranslateService);
  private window = inject(WindowToken);

  readonly currentLang = signal<string>(this.initialLang());
  readonly currentLang$ = toObservable(this.currentLang);

  private initialLang(): string {
    // A stored choice has to win over the browser locale, otherwise every cold load
    // re-derives the language from `navigator.language` — and prerender, where
    // `getBrowserLang()` is undefined, always produced English.
    const stored = this.window.localStorage.getItem(LANG_STORAGE_KEY);
    if (stored && SUPPORTED_LANGS.includes(stored)) {
      return stored;
    }
    const browser = (this.translate.getBrowserLang() || 'en').toLowerCase().split('-')[0];
    return SUPPORTED_LANGS.includes(browser) ? browser : 'en';
  }

  constructor() {
    this.currentLang$.subscribe((lang) => {
      this.window.localStorage.setItem(LANG_STORAGE_KEY, lang);
      void this.translate.use(lang);
    });
  }

  use(lang: string): void {
    this.currentLang.set(lang);
  }

  instant(key: string | Array<string>, interpolateParams?: object): string {
    return this.translate.instant(key, interpolateParams);
  }

  get(key: string | Array<string>, interpolateParams?: object): Observable<string | any> {
    return this.translate.get(key, interpolateParams);
  }
}
