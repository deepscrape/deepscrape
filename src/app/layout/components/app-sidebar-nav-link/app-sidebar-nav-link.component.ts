import { NgClass } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, computed, EventEmitter, inject, Input, Output } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs/internal/Subscription';
import { RemoveClassDirective } from 'src/app/core/directives/removeclass.directive';
import { RippleDirective } from 'src/app/core/directives/ripple.directive';
import { cleanAndParseJSON } from 'src/app/core/functions';
import { AuthService, LocalStorage, ScreenResizeService } from 'src/app/core/services';
import { Session } from 'src/app/core/types';
import { themeStorageKey } from 'src/app/shared/theme-picker/theme-picker.component';
import { AppUserLayoutComponent } from '../../full';
import { orgScopedUrl } from 'src/app/core/guards/host-routing.policy';

@Component({
  selector: 'app-sidebar-nav-link',
  imports: [NgClass, MatIcon, RouterLink, RippleDirective, RemoveClassDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-sidebar-nav-link.component.html',
  styleUrl: './app-sidebar-nav-link.component.scss'
})
export class AppSidebarNavLinkComponent {
  private userLayout = inject(AppUserLayoutComponent)
  private authService = inject(AuthService)
  @Input() link: any
  private localStorage: Storage = inject(LocalStorage)

  /**
   * The nav url moved under the active org, so a click lands on the canonical `/{orgId}/…`
   * instead of bouncing through the legacy route.
   *
   * `/admin/**` and `/service/**` are left alone — neither is org-scoped, so the console's own
   * nav and the auth surface keep working. With no active org this is a no-op, and the bare
   * routes still resolve.
   */
  protected readonly linkUrl = computed(() =>
    this.link?.url ? orgScopedUrl(this.link.url, this.userLayout?.selectedOrgId() ?? null) : null
  )

  private routeSub: Subscription

  public get isAdmin() {
    return this.authService.isAdmin
  }
  public hasVariant() {
    return this.link.variant ? true : false
  }

  private hasIdentifier() {
    return this.link?.identity ? true : false
  }

  public hasChildren() {

    return this.link.children && this.link.children.length > 0
  }

  public isBadge() {
    return this.link.badge ? true : false
  }

  public isServicealLink() {
    return (this.link.url.substring(0, 4) === 'http' || this.link.url.substring(0, 5) === 'https') ? true : false
  }

  public isIcon() {

    const icon = this.link.icon ? true : false

    return icon
  }

  protected shouldDisplaySvgIcon(icon: string | { matIcon?: string, fontSet?: string, fontIcon?: string }) {

    return !icon?.valueOf().hasOwnProperty('fontSet') && typeof icon === 'string' ? icon : ''
  }


  constructor(
    private resizeSvc: ScreenResizeService,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {

    // this.toggleMenu = false
  }

  ngOnInit(): void {
    //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
    //Add 'implements OnInit' to the class.
    if (this.hasIdentifier() && this.link.url) {

      const currentUser = this.localStorage?.getItem('currentUser')

      if (typeof currentUser !== undefined && currentUser !== null) {

        const user: Session | null = cleanAndParseJSON(currentUser) as Session

        if (this.contains(user?.username))
          return

        this.link.url = /* user !== null ? `/${user?.username}` + this.link.url :  */this.link.url
      }
    }

    this.routeSub = this.router.events.subscribe((event: any) => {

      if ((event instanceof NavigationEnd) && event.urlAfterRedirects === this.link.url) {
        this.link.active = this.isParentActive()
        this.cdr.detectChanges() // Call detectChanges here
      } else {
        if (!event.url && this.link.url) {
          this.link.active = this.isParentActive(event.urlAfterRedirects)
          this.cdr.detectChanges() // Call detectChanges here
        }
      }
    })

    this.InitLinkActive()
  }
  private contains(username: string): boolean {
    return this.link.url.toLowerCase().indexOf(username?.toLowerCase()) !== -1;
  }

  private InitLinkActive() {
    // this.link.active = this.router.isActive(this.link.url, true)
    this.link.active = this.isParentActive()
  }

  private isParentActive(url: string = this.link.url) {
    return this.router.url.startsWith(url)
  }
  protected closeSideBar() {
    
    const { screenWidth } = this.resizeSvc.updateScreenSize()

    if (screenWidth >= 992)
      return

    if (this.hasChildren())
      return

    this.userLayout.onCloseAsideBar(true)
  }


  themeIsDark() {

    return this.localStorage?.getItem(themeStorageKey) === 'true'
  }

  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.
    this.routeSub?.unsubscribe()
  }
}
