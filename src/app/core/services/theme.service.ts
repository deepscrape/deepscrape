import { inject, Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { themeStorageKey } from 'src/app/shared/theme-picker/theme-picker.component';
import { LocalStorage } from './storage.service';
import { WindowToken } from './window.service';

@Injectable({ providedIn: 'root' })
export class ThemeService {
    private localStorage = inject(LocalStorage);
    private window = inject(WindowToken);
    private themeSubject: BehaviorSubject<boolean>;

    constructor() {
        // Explicit 'true'/'false' wins; no stored key means System → follow the OS.
        const stored = this.localStorage?.getItem(themeStorageKey);
        const systemDark = stored == null
            && (this.window?.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false);
        this.themeSubject = new BehaviorSubject<boolean>(stored === 'true' || systemDark);
    }

    get isDarkMode$(): Observable<boolean> {
        return this.themeSubject.asObservable();
    }

    get isDarkMode(): boolean {
        return this.themeSubject.value;
    }

    setDarkMode(isDark: boolean) {
        this.themeSubject.next(isDark);
    }
}
