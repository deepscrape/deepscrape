import {
  Component,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { AppFooterComponent } from '../../footer'
// import { AppHeaderComponent } from '../../header';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { LocalStorage, WindowToken } from 'src/app/core/services';
import { themeStorageKey } from 'src/app/shared/theme-picker/theme-picker.component';
import { LandingSubheaderComponent } from 'src/app/shared/landing-subheader/landing-subheader.component';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-not-found',
    imports: [RouterLink, AppFooterComponent, TranslateModule, LandingSubheaderComponent],
    templateUrl: './app-not-found.component.html',
    styleUrl: './app-not-found.component.scss'
})
export class NotFoundComponent {
    private window = inject(WindowToken);
    private localStorage = inject(LocalStorage)
    footerColor: string = '';


    ngOnInit(): void {
        //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
        //Add 'implements OnInit' to the class.
        this.footerColor = this.isThemeDark() ? 'dark:bg-[#212121]' : 'bg-[#f5f5f5]';
    }


    isThemeDark(): boolean {
        const stored = this.localStorage?.getItem(themeStorageKey);
        if (stored === 'true') return true;
        if (stored === 'false') return false;
        return this.window?.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
    }

}