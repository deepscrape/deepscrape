import { AsyncPipe, isPlatformBrowser, NgClass, NgOptimizedImage } from '@angular/common';
import { ChangeDetectionStrategy, Component, HostBinding, inject, Inject, PLATFORM_ID, OnDestroy } from '@angular/core'
import { Auth, User, UserInfo } from '@angular/fire/auth'
import { doc, Firestore, getDoc } from '@angular/fire/firestore'
import { MatIcon } from '@angular/material/icon'
import { MatProgressSpinner } from '@angular/material/progress-spinner'
import { TranslateModule } from '@ngx-translate/core'
import { ActivatedRoute, ChildrenOutletContexts, NavigationCancel, NavigationEnd, NavigationError, NavigationStart, Router, RouterLink, RouterOutlet } from '@angular/router'
import { FormControl, FormsModule } from '@angular/forms'
import { catchError, delay, finalize, from, map, switchMap, throwError, timer, fromEvent } from 'rxjs' // Added fromEvent
import { Observable } from 'rxjs/internal/Observable'
import { of } from 'rxjs/internal/observable/of'
import { take } from 'rxjs/internal/operators/take'
import { Subscription } from 'rxjs/internal/Subscription'
import { asideBarAnimation, fadeInOutAnimation, PopupAnimation } from 'src/app/animations'
import { ImageSrcsetDirective, Outsideclick, RippleDirective } from 'src/app/core/directives'
import { ProviderPipe } from 'src/app/core/pipes'
import { AuthService, CartService, FirestoreService, LocalStorage, OrganizationInvitation, OrganizationService, OrganizationSummary, ScreenResizeService, ScrollService, ThemeService, WindowToken } from 'src/app/core/services'
import { Users } from 'src/app/core/types'
import { LangPickerComponent, NotificationBellComponent, themeStorageKey, ThemeToggleComponent } from 'src/app/shared';
import { AppSidebarComponent } from '../../components'
import { AppFooterComponent } from '../../footer'
import { SCREEN_SIZE } from 'src/app/core/enum'
import { CartPackNotifyComponent, DropdownCartComponent } from 'src/app/core/components'
import { DropdownComponent } from 'src/app/core/components'
/**
 * TODO: comment Component
 * @description Component for user layout including sidebar, header, and footer
 */
@Component({
  selector: 'app-user-layout', 
  imports: [NgClass, RouterOutlet, DropdownComponent, RouterLink, ThemeToggleComponent, AsyncPipe, MatIcon, MatProgressSpinner, ImageSrcsetDirective, ProviderPipe, Outsideclick, AppSidebarComponent, AppFooterComponent, RippleDirective, CartPackNotifyComponent, DropdownCartComponent, AsyncPipe, LangPickerComponent, NotificationBellComponent, FormsModule, TranslateModule],
  animations: [fadeInOutAnimation, PopupAnimation, asideBarAnimation],
  templateUrl: './app-user-layout.component.html',
  styleUrl: './app-user-layout.component.scss'
})
export class AppUserLayoutComponent implements OnDestroy {

  private window: Window = inject(WindowToken)
  private localStorage = inject(LocalStorage)

  private themePicker = inject(ThemeService)
  isDarkMode$: Observable<boolean> = this.themePicker.isDarkMode$

  // bg-gray-100 dark:bg-gray-900
  @HostBinding('class') classes = 'h-full w-full flex flex-col  min-h-svh'
  private firestoreService = inject(FirestoreService)
  private organizationService = inject(OrganizationService)
  size!: SCREEN_SIZE;
  
  footerColor: string = '';
  sizeSub: Subscription = new Subscription(); // Initialize sizeSub

  user: Users & { currProviderData: UserInfo | null } | null = null
  organizations: OrganizationSummary[] = []
  invitations: OrganizationInvitation[] = []
  selectedOrgId: string | null = null
  workspaceDropdownOptions: Array<{ name: string; code: string }> = []
  readonly workspaceControl = new FormControl<{ name: string; code: string }>({ name: 'SHELL.SELECT_WORKSPACE', code: '' }, { nonNullable: true })
  orgLoading = false
  inviteActionLoading = false
  cartPackager$: Observable<any>

  // Toggle Button To Open and Close Profile Dropdown Menu
  showProfileMenu: boolean

  closeAsideBar!: boolean

  protected loginPath: string

  loading: boolean
  userLoading: boolean
  accountImageLoading: boolean
  logoutSubscription: Subscription
  userSubscription: Subscription
  orgLoadSubscription: Subscription
  invitationLoadSubscription: Subscription
  invitationActionSubscription: Subscription
  private routerEventSubscription: Subscription
  protected compIsLoading = true;
  /* animations */
  viewSmallDevices: boolean
  isThemeDark: boolean = false; // New property
  currentRouteAnimation: string | undefined; // Property to hold animation state

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
        this.compIsLoading = true
      }

      if (event instanceof NavigationEnd) {
        this.compIsLoading = false
        // Update the animation state when navigation ends
        const outlet = this.contexts.getContext('primary')?.outlet;
        if (outlet && outlet.activatedRouteData && outlet.activatedRouteData['animation']) {
          this.currentRouteAnimation = outlet.activatedRouteData['animation'];
        } else {
          this.currentRouteAnimation = undefined;
        }
      }

      if (event instanceof NavigationCancel || event instanceof NavigationError) {
        this.compIsLoading = false
      }
    })

    this.closeAsideBar = false
    this.viewSmallDevices = false

    // Set the initial values
    this.loading = false

    this.showProfileMenu = false

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
      this.user = this.route.snapshot.data['user']
      this.loadOrganizationContext()
      // this.GetUserProfile();
      const storedTheme = this.localStorage?.getItem(themeStorageKey);
      this.isThemeDark = storedTheme === 'true'
        || (storedTheme !== 'false' && (this.window?.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false));

      // Listen for changes in local storage to update theme
      this.sizeSub.add(fromEvent<StorageEvent>(this.window, 'storage').subscribe((event: StorageEvent) => {
        if (event.key === themeStorageKey) {
          this.isThemeDark = event.newValue === 'true'
            || (event.newValue !== 'false' && (this.window?.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false));
        }
      }));
    }

    this.footerColor = 'userlayout';
    this.compIsLoading = !this.router.navigated
    this.InitCloseSideBarOnSmallDevices()
  }

  private loadOrganizationContext(): void {
    if (!this.user?.uid) {
      this.organizations = []
      this.invitations = []
      this.selectedOrgId = null
      return
    }

    this.orgLoading = true
    this.orgLoadSubscription?.unsubscribe()
    this.orgLoadSubscription = this.organizationService.listMyOrganizations()
      .pipe(finalize(() => {
        this.orgLoading = false
      }))
      .subscribe({
        next: (response) => {
          this.organizations = response.organizations || []
          this.selectedOrgId = this.organizationService.getActiveOrganization() || this.organizations[0]?.id || null
          this.workspaceDropdownOptions = this.organizations.map((org) => ({
            code: org.id,
            name: `${org.name || org.slug || org.id} (${org.membership?.role || 'member'})`,
          }))
          const selectedOption = this.workspaceDropdownOptions.find((option) => option.code === this.selectedOrgId)
          if (selectedOption) {
            this.workspaceControl.setValue(selectedOption)
          } else if (this.workspaceDropdownOptions.length > 0) {
            this.workspaceControl.setValue(this.workspaceDropdownOptions[0])
          }
        },
        error: (error) => {
          console.error('Failed loading organizations in user layout:', error)
          this.organizations = []
          this.workspaceDropdownOptions = []
        },
      })

    this.invitationLoadSubscription?.unsubscribe()
    this.invitationLoadSubscription = this.organizationService.listMyInvitations().subscribe({
      next: (response) => {
        this.invitations = response.invitations || []
      },
      error: (error) => {
        console.error('Failed loading invitations in user layout:', error)
        this.invitations = []
      },
    })
  }

  switchOrganization(orgId: string): void {
    this.selectedOrgId = orgId
    this.organizationService.setActiveOrganization(orgId)
    const selectedOption = this.workspaceDropdownOptions.find((option) => option.code === orgId)
    if (selectedOption) {
      this.workspaceControl.setValue(selectedOption)
    }
  }

  onWorkspaceSelected(option: any): void {
    const selectedCode = option?.code
    if (!selectedCode) {
      return
    }

    this.switchOrganization(selectedCode)
  }

  acceptInvitation(invitationId: string): void {
    if (!invitationId || this.inviteActionLoading) {
      return
    }

    this.inviteActionLoading = true
    this.invitationActionSubscription?.unsubscribe()
    this.invitationActionSubscription = this.organizationService.acceptInvitation(invitationId)
      .pipe(finalize(() => {
        this.inviteActionLoading = false
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
    this.viewSmallDevices = this.closeAsideBar = screenWidth < 992

    this.sizeSub = this.resizeSvc.onResize$.subscribe(x => {

      this.size = x
      if (this.closeAsideBar != undefined) {
        this.closeAsideBar = this.viewSmallDevices = this.size < SCREEN_SIZE.LG
        // this.handleScrollbar()
      }
    })
    // this.handleScrollbar()
  }

  addAsideBar(value: boolean) {

    if (value === this.closeAsideBar) // The value was same as this component
      this.closeAsideBar = !value

    else this.closeAsideBar = value

    this.handleScrollbar()
  }

  onCloseAsideBar(event: boolean) {
    this.closeAsideBar = event

    this.handleScrollbar()
  }

  private handleScrollbar() {
    if (this.closeAsideBar) // If aside bar is closed, show scrollbar
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
      this.showProfileMenu = true

    // on outside click
    else this.showProfileMenu = !this.showProfileMenu

  }

  closeProfileMenu(event: Event, username?: string) {
    this.showProfileMenu = false
    const target = event.target as HTMLElement
    let altAttribute = target.getAttribute('role')

    switch (altAttribute) {
      case 'dashboard':
        this.router.navigate(['/dashboard'])
        break
      case 'billing':
        this.router.navigate(['/billing'])
        break
      case 'settings':
        this.router.navigate([username ? username : '' + '/settings'])
        break
      case 'chatai':
        this.router.navigate(['/chatai'])
        break
      default:
        break

    }
  }


  logout() {
    this.loading = true
    this.logoutSubscription = this.authService.logout().pipe(
      delay(1000),
      finalize(() => {
        this.loading = false
        this.showProfileMenu = false
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
    return this.currentRouteAnimation;
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
