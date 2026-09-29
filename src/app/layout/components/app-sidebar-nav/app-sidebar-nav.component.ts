import { isPlatformBrowser, NgClass, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, inject, Output, PLATFORM_ID, TemplateRef, ViewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { adminNavigation, navigation } from 'src/app/_nav';
import { hostClassOf } from 'src/app/core/guards/host-routing.policy';
import { AppSidebarNavItemComponent } from '../app-sidebar-nav-item/app-sidebar-nav-item.component';
import { LoadingService } from 'src/app/core/services';
import { MatIcon } from '@angular/material/icon';
import { timer } from 'rxjs/internal/observable/timer';
import { AuthService } from 'src/app/core/services/auth.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-sidebar-nav',
  imports: [AppSidebarNavItemComponent, NgTemplateOutlet, MatIcon, NgClass],
  templateUrl: './app-sidebar-nav.component.html',
  styleUrl: './app-sidebar-nav.component.scss'
})
export class AppSidebarNavComponent {

  @ViewChild('sidebarNavTemplate') sidebarNavTemplate: TemplateRef<any>
  // ponytail: `window` is absent while the server renders `/dashboard` and `/admin`,
  // so the host probe is platform-guarded and falls back to the app nav.
  private readonly isConsoleHost = isPlatformBrowser(inject(PLATFORM_ID)) &&
    hostClassOf(window.location.hostname) === 'console'
  private navigation: any[] = this.isConsoleHost ? adminNavigation : navigation
  protected isAdmin = false

  constructor(private loadingService: LoadingService, private authService: AuthService, private cdr: ChangeDetectorRef) {
    this.loadingService.startLoading()

    this.authService.user$
      .pipe(takeUntilDestroyed())
      .subscribe((user) => {
        const role = String(user?.role || '').trim().toLowerCase()
        this.isAdmin = this.authService.isAdmin || role === 'admin'
        this.cdr.markForCheck()
      })
  }

  ngAfterViewInit() {
    timer(400).subscribe(() => {
      this.loadingService.stopLoading();
    })
  }

  protected get filteredNavigation() {
    // The console is admin-only (its routes sit behind `adminGuard`), so its nav needs
    // no gating. On the app origin the single 'Console' cross-link is hidden from
    // non-admins; it stays a relative link and the host guard forwards `/admin`.
    if (this.isConsoleHost) {
      return this.navigation
    }
    return this.navigation.filter(item => item.name !== 'Console' || this.isAdmin)
  }

  public isDivider(item: any) {
    // console.log(item)
    return item.divider ? true : false
  }
  public isTitle(item: any) {
    return item.title ? true : false
  }

}
