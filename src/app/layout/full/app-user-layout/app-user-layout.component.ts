import { AsyncPipe, isPlatformBrowser, NgClass, NgOptimizedImage } from '@angular/common';
import { ChangeDetectionStrategy, Component, HostBinding, inject, Inject, PLATFORM_ID, OnDestroy, signal } from '@angular/core'
import { Auth, User, UserInfo } from '@angular/fire/auth'
import { doc, Firestore, getDoc } from '@angular/fire/firestore'
import { MatIcon } from '@angular/material/icon'
import { MatProgressSpinner } from '@angular/material/progress-spinner'
import { TranslateModule } from '@ngx-translate/core'
import { ActivatedRoute, ChildrenOutletContexts, NavigationCancel, NavigationEnd, NavigationError, NavigationStart, Router, RouterLink, RouterOutlet } from '@angular/router'
import { FormControl, FormsModule } from '@angular/forms'
import { delay, finalize, timer } from 'rxjs'
import { Observable } from 'rxjs/internal/Observable'
import { of } from 'rxjs/internal/observable/of'
import { take } from 'rxjs/internal/operators/take'
import { Subscription } from 'rxjs/internal/Subscription'
import { asideBarAnimation, fadeInOutAnimation, PopupAnimation } from 'src/app/animations'
import { ImageSrcsetDirective } from 'src/app/core/directives/image.srcset.directive'
import { Outsideclick } from 'src/app/core/directives/outsideclick.directive'
import { RippleDirective } from 'src/app/core/directives/ripple.directive'
import { ProviderPipe } from 'src/app/core/pipes'
import { AuthService, CartService, FirestoreService, OrganizationInvitation, OrganizationService, OrganizationSummary, ScreenResizeService, ScrollService, ThemeService } from 'src/app/core/services'
import { Users } from 'src/app/core/types'
import { LangPickerComponent } from 'src/app/shared/lang-picker/lang-picker.component';
import { NotificationBellComponent } from 'src/app/shared/notification-bell/notification-bell.component';
import { ThemeToggleComponent } from 'src/app/shared/theme-picker/theme-picker.component';
import { AppSidebarComponent } from '../../components'
import { AppFooterComponent } from '../../footer'
import { SCREEN_SIZE } from 'src/app/core/enum'
import { ORIGINS, orgScopedUrl } from 'src/app/core/guards/host-routing.policy'
import { CartPackNotifyComponent, DropdownCartComponent } from 'src/app/core/components'
import { DropdownComponent } from 'src/app/core/components'
/**
 * TODO: comment Component
 * @description Component for user layout including sidebar, header, and footer
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-user-layout', 
  imports: [NgClass, RouterOutlet, DropdownComponent, RouterLink, ThemeToggleComponent, AsyncPipe, MatIcon, MatProgressSpinner, ImageSrcsetDirective, ProviderPipe, Outsideclick, AppSidebarComponent, AppFooterComponent, RippleDirective, CartPackNotifyComponent, DropdownCartComponent, AsyncPipe, LangPickerComponent, NotificationBellComponent, FormsModule, TranslateModule],
  animations: [fadeInOutAnimation, PopupAnimation, asideBarAnimation],
  templateUrl: './app-user-layout.component.html',
  styleUrl: './app-user-layout.component.scss'
})
export class AppUserLayoutComponent implements OnDestroy {

  private themePicker = inject(ThemeService)
  isDarkMode$: Observable<boolean> = this.themePicker.isDarkMode$

  /** Marketing apex. The brand mark must resolve to the site, never to a subdomain. */
  protected readonly apexUrl: string = ORIGINS.marketing;

  // bg-gray-100 dark:bg-gray-900
  @HostBinding('class') classes = 'h-full w-full flex flex-col  min-h-svh'
  private firestoreService = inject(FirestoreService)
  private organizationService = inject(OrganizationService)
  size!: SCREEN_SIZE;
  
  footerColor = signal('');
  sizeSub: Subscription = new Subscription(); // Initialize sizeSub

  user = signal<Users & { currProviderData: UserInfo | null } | null>(null)
  organizations = signal<OrganizationSummary[]>([])
  invitations = signal<OrganizationInvitation[]>([])
  selectedOrgId = signal<string | null>(null)
  workspaceDropdownOptions = signal<Array<{ name: string; code: string }>>([])
  readonly workspaceControl = new FormControl<{ name: string; code: string }>({ name: 'SHELL.SELECT_WORKSPACE', code: '' }, { nonNullable: true })
  orgLoading = signal(false)
  inviteActionLoading = signal(false)
  cartPackager$: Observable<any>

  // Toggle Button To Open and Close Profile Dropdown Menu
  showProfileMenu = signal(false)

  closeAsideBar = signal(false)

  loading = signal(false)
  userLoading = signal(false)
  logoutSubscription: Subscription
  orgLoadSubscription: Subscription
  invitationLoadSubscription: Subscription
  invitationActionSubscription: Subscription
  private routerEventSubscription: Subscription
  protected compIsLoading = signal(true);
  /* animations */
  viewSmallDevices = signal(false)
  currentRouteAnimation = signal<string | undefined>(undefined); // Property to hold animation state

  constructor(

    @Inject(PLATFORM_ID) private platformId: object,
    private contexts: ChildrenOutletContexts,
    private resizeSvc: ScreenResizeService,
    private router: Router,
    private route: ActivatedRoute,
    private auth: Auth,

    private authService: AuthService,
    private cartService: CartService,
    private scrollService: ScrollService,
  ) {

    this.routerEventSubscription = this.router.events.subscribe((event: any) => {
      if (event instanceof NavigationStart) {
        this.compIsLoading.set(true)
      }

      if (event instanceof NavigationEnd) {
        this.compIsLoading.set(false)
        // Update the animation state when navigation ends
        const outlet = this.contexts.getContext('primary')?.outlet;
        if (outlet && outlet.activatedRouteData && outlet.activatedRouteData['animation']) {
          this.currentRouteAnimation.set(outlet.activatedRouteData['animation']);
        } else {
          this.currentRouteAnimation.set(undefined);
        }
      }

      if (event instanceof NavigationCancel || event instanceof NavigationError) {
        this.compIsLoading.set(false)
      }
    })

    // this.user$ = of(null)
    this.cartPackager$ = this.cartService.getCart$
    this.orgLoadSubscription = new Subscription()
    this.invitationLoadSubscription = new Subscription()
    this.invitationActionSubscription = new Subscription()


  }

  ngOnInit(): void {
    //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
    //Add 'implements OnInit' to the class.
    if (isPlatformBrowser(this.platformId)) {
      this.user.set(this.route.snapshot.data['user'])
      this.loadOrganizationContext()
    }

    this.footerColor.set('userlayout');
    this.compIsLoading.set(!this.router.navigated)
    this.InitCloseSideBarOnSmallDevices()
  }

  private loadOrganizationContext(): void {
    if (!this.user()?.uid) {
      this.organizations.set([])
      this.invitations.set([])
      this.selectedOrgId.set(null)
      return
    }

    this.orgLoading.set(true)
    this.orgLoadSubscription?.unsubscribe()
    this.orgLoadSubscription = this.organizationService.listMyOrganizations()
      .pipe(finalize(() => {
        this.orgLoading.set(false)
      }))
      .subscribe({
        next: (response) => {
          const organizations = response.organizations || []
          const options = organizations.map((org) => ({
            code: org.id,
            name: `${org.name || org.slug || org.id} (${org.membership?.role || 'member'})`,
          }))
          this.organizations.set(organizations)
          this.workspaceDropdownOptions.set(options)
          const activeOrgId = this.organizationService.getActiveOrganization() || organizations[0]?.id || null
          this.selectedOrgId.set(activeOrgId)
          const selectedOption = options.find((option) => option.code === activeOrgId)
          if (selectedOption) {
            this.workspaceControl.setValue(selectedOption)
          } else if (options.length > 0) {
            this.workspaceControl.setValue(options[0])
          }
        },
        error: (error) => {
          console.error('Failed loading organizations in user layout:', error)
          this.organizations.set([])
          this.workspaceDropdownOptions.set([])
        },
      })

    this.invitationLoadSubscription?.unsubscribe()
    this.invitationLoadSubscription = this.organizationService.listMyInvitations().subscribe({
      next: (response) => {
        this.invitations.set(response.invitations || [])
      },
      error: (error) => {
        console.error('Failed loading invitations in user layout:', error)
        this.invitations.set([])
      },
    })
  }

  switchOrganization(orgId: string): void {
    const previous = this.selectedOrgId()
    this.selectedOrgId.set(orgId)
    this.organizationService.setActiveOrganization(orgId)
    const selectedOption = this.workspaceDropdownOptions().find((option) => option.code === orgId)
    if (selectedOption) {
      this.workspaceControl.setValue(selectedOption)
    }

    // The org is part of the URL now, so the switch has to move the URL with it. Without this
    // the address bar keeps the old org and a refresh re-reads it, silently switching back.
    const [path] = this.router.url.split(/[?#]/)
    if (path.startsWith('/admin')) {
      return // Console surface: not org-scoped, so leave the URL alone.
    }

    const segments = path.split('/').filter(Boolean)
    const tail = segments[0] === previous ? segments.slice(1) : segments
    void this.router.navigateByUrl(`/${orgId}${tail.length ? `/${tail.join('/')}` : ''}`)
  }

  onWorkspaceSelected(option: any): void {
    const selectedCode = option?.code
    if (!selectedCode) {
      return
    }

    this.switchOrganization(selectedCode)
  }

  acceptInvitation(invitationId: string): void {
    if (!invitationId || this.inviteActionLoading()) {
      return
    }

    this.inviteActionLoading.set(true)
    this.invitationActionSubscription?.unsubscribe()
    this.invitationActionSubscription = this.organizationService.acceptInvitation(invitationId)
      .pipe(finalize(() => {
        this.inviteActionLoading.set(false)
      }))
      .subscribe({
        next: () => {
          this.loadOrganizationContext()
        },
        error: (error) => {
          console.error('Failed accepting invitation:', error)
        },
      })
  }



  private InitCloseSideBarOnSmallDevices() {
    const { screenWidth } = this.resizeSvc.updateScreenSize()

    // On startup, check the screen size, to close the e aside bar
    const smallScreen = screenWidth < 992
    this.viewSmallDevices.set(smallScreen)
    this.closeAsideBar.set(smallScreen)

    this.sizeSub = this.resizeSvc.onResize$.subscribe(x => {

      this.size = x
      const small = this.size < SCREEN_SIZE.LG
      this.viewSmallDevices.set(small)
      this.closeAsideBar.set(small)
      // this.handleScrollbar()
    })
    // this.handleScrollbar()
  }

  addAsideBar(value: boolean) {

    if (value === this.closeAsideBar()) // The value was same as this component
      this.closeAsideBar.set(!value)

    else this.closeAsideBar.set(value)

    this.handleScrollbar()
  }

  onCloseAsideBar(event: boolean) {
    this.closeAsideBar.set(event)

    this.handleScrollbar()
  }

  private handleScrollbar() {
    if (this.closeAsideBar()) // If aside bar is closed, show scrollbar
      this.scrollService.showScroll()
    else // If aside bar is open, hide scrollbar
      this.scrollService.hideScroll()
  }

  // private GetUserProfile(username?: string) {
  //   this.userLoading = true;
  //   this.user$ = of(this.auth.currentUser).pipe(
  //     take(1),
  //     switchMap(user => {
  //       if (!user) {
  //         return of(null)
  //       }
  //       return from(this.firestoreService.getUserData(user.uid)).pipe(
  //         catchError(err => {
  //           console.error(err)
  //           return of(null)
  //         })
  //       )
  //     }),
  //     finalize(() => this.userLoading = false)
  //   );
  // }

  openProfileMenu(event?: any): void {
    // if user press profile button
    if (event && (event.target.alt === "user photo"))
      this.showProfileMenu.set(true)

    // on outside click
    else this.showProfileMenu.update(open => !open)

  }

  /**
   * Navigate to `/{orgId}/…` rather than the bare path, so the profile menu does not spend a
   * redirect. The anchors also carry a static `routerLink`; both land on the same canonical url,
   * because `orgScopeGuard` rewrites a bare one.
   *
   * `username` is unused — it stays in the signature because the template passes it. The old
   * `settings` case navigated to `[username ? username : ...]`, which sent a bare uid as a route
   * path and 404'd; it now goes to `/settings` like every other entry.
   */
  closeProfileMenu(event: Event, username?: string) {
    this.showProfileMenu.set(false)
    const target = event.target as HTMLElement
    const role = target.getAttribute('role')

    switch (role) {
      case 'dashboard':
        this.go('/dashboard')
        break
      case 'billing':
        this.go('/billing')
        break
      case 'settings':
        this.go('/settings')
        break
      case 'chatai':
        this.go('/chatai')
        break
      default:
        break

    }
  }

  /** Navigate to an app page in its canonical org-scoped form. */
  private go(url: string): void {
    this.router.navigateByUrl(orgScopedUrl(url, this.selectedOrgId()))
  }


  logout() {
    this.loading.set(true)
    this.logoutSubscription = this.authService.logout().pipe(
      delay(1000),
      finalize(() => {
        this.loading.set(false)
        this.showProfileMenu.set(false)
      })
    ).subscribe({
      next: () => {
        console.log('User logged out')
        timer(300).subscribe(() => {
          this.router.navigate(['/'])
        })
      },
      error: (error) => {
        console.error('Logout error:', error)
      },
      complete: () => {
        this.logoutSubscription?.unsubscribe()
      }
    })
  }
  getAnimationData(outlet: RouterOutlet) {
    // return this.contexts.getContext('primary')?.route?.snapshot?.data?.['animation']
    return this.currentRouteAnimation();
  }

  // Removed themeIsDark() method

  ngOnDestroy(): void {
    // Cleanup all subscriptions to prevent memory leaks
    this.logoutSubscription?.unsubscribe()
    this.orgLoadSubscription?.unsubscribe()
    this.invitationLoadSubscription?.unsubscribe()
    this.invitationActionSubscription?.unsubscribe()
    this.sizeSub?.unsubscribe()
    this.routerEventSubscription?.unsubscribe()
  }
}
