import {
  Component,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { AppFooterComponent } from '../../footer'
// import { AppHeaderComponent } from '../../header';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
// Direct paths, not the `core/services` barrel: the barrel re-exports ~44 root
// services, and pulling it in here put the whole set in the 404 chunk for the sake
// of two InjectionTokens.
import { WindowToken } from '../../../core/services/window.service';
import { LocalStorage } from '../../../core/services/storage.service';
import { isDarkTheme } from 'src/app/shared/theme-picker/theme-storage';
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
        return isDarkTheme(this.localStorage, this.window)
    }

}