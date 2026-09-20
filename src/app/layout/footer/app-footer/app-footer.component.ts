import {
  Component,
  DestroyRef,
  inject,
  Input,
  ChangeDetectionStrategy,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { TranslateModule } from '@ngx-translate/core';
import { RouterLink } from '@angular/router';
import { LocalStorage, WindowToken } from 'src/app/core/services';
import { myIcons, themeStorageKey } from 'src/app/shared';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-footer',
    imports: [LucideAngularModule, TranslateModule, RouterLink],
    templateUrl: './app-footer.component.html',
    styleUrl: './app-footer.component.scss'
})
export class AppFooterComponent {
    private window = inject(WindowToken);
    @Input() color?: string = ''
    readonly icons = myIcons
    private localStorage = inject(LocalStorage)
    protected footer = {
        github: myIcons['github'],
        linkedin: myIcons['linkedin'],
        mail: myIcons['mail']
    }

    constructor() {
        
    }

    ngOnInit(): void {
        //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
        //Add 'implements OnInit' to the class.
        if (!this.color) {
            this.color = this.isThemeDark() ? 'dark:bg-[#1a1a25]' : 'bg-gray-200';
        }
    }


    private isThemeDark(): boolean {
        const stored = this.localStorage?.getItem(themeStorageKey);
        if (stored === 'true') return true;
        if (stored === 'false') return false;
        return this.window?.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
    }
}
