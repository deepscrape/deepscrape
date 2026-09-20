import { ChangeDetectionStrategy, Component, DestroyRef, inject, PLATFORM_ID, signal, ViewChild } from '@angular/core'
import { NavigationCancel, NavigationEnd, NavigationError, NavigationStart, Router, RouterOutlet } from '@angular/router'
import { MatProgressSpinner } from '@angular/material/progress-spinner'
import { HttpClient } from '@angular/common/http'
import { LoadingBarRouterModule } from '@ngx-loading-bar/router'
import { Subscription } from 'rxjs/internal/Subscription'
import { LoggerService, SnackbarService, SvgIconService, HeartbeatService, AnalyticsService, AuthService } from './core/services'
import { CookieConsentComponent } from './core/components/cookie-consent/cookie-consent.component';
import { SessionTimeoutService, DeviceVerificationService } from './core/services'
import { AnimatedBgComponent, LangPickerComponent, ThemeToggleComponent } from './shared'
import { SizeDetectorComponent } from './core/components/size-detector/size-detector.component'
import { SnackbarComponent, SnackBarType } from './core/components/snackbar/snackbar.component'
import { LoadingBarHttpClientModule } from '@ngx-loading-bar/http-client'
import { catchError, filter, forkJoin, of, switchMap, take, tap, timer } from 'rxjs'
import { isPlatformBrowser, isPlatformServer } from '@angular/common'
import { fadeInOutAnimation } from './animations'
import { Inject, OnInit, OnDestroy, AfterViewInit } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { NgswUpdateService } from './core/services/ngsw-update.service'
import { environment } from 'src/environments/environment'

/* 
                     ,//@@@.
                .///////@@@@@@@&.
           ,////////////@@@@@@@@@@@@@/
      ./////////////////#@@@@@@@@@@@@@@@@@,
 ,/////////////////.         ,&@@@@@@@@@@@@@@@@#
/////////////.                     %@@@@@@@@@@@@@
/////////.                             .%@@@@@@@@
//////.                                   /@@@@@@
///////     @@%     .@@/    .@@@@@@/      %@@@@@@
.//////     @@@@(   .@@/   @@@%. ,@@@#    @@@@@@&
.//////     @@%@@@  .@@/  &@@             @@@@@@(
 //////     @@# ,@@@.@@/  @@@   &@@@@@.   @@@@@@.
 //////,    @@#   %@@@@/  ,@@@    *@@#   ,@@@@@@
 //////.    @@#     @@@/    @@@@@@@@,    #@@@@@@
 ,//////                                 @@@@@@&
 .//////                                 @@@@@@/
  //////.      @@@  @@@  @@  @ @@@@     .@@@@@@.
  //////,     @    @   @ @ @ @ @==      (@@@@@@)
  .//////      @@@  @@@  @  @@ @        &@@@@@@
  .///////.                           %@@@@@@@&
   ///////////                    ,@@@@@@@@@@@(
     ,///////////,             #@@@@@@@@@@@&
        .///////////.       &@@@@@@@@@@@%
           ./////////////@@@@@@@@@@@@*
              ./////////@@@@@@@@@@,
                  ./////@@@@@@%
                     .//@@@#

     The World's Original Angular Conference
      May 1st–3rd 2019 Salt Lake City, Utah */

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, LoadingBarRouterModule, LoadingBarHttpClientModule, MatProgressSpinner, 
    SnackbarComponent, SizeDetectorComponent, AnimatedBgComponent, CookieConsentComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ThemeToggleComponent, NgswUpdateService, LangPickerComponent, LoggerService],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  // host: {
  //   '[@routeAnimation]': 'getRouteAnimationData(routerOutlet)',
  //   '[style.backgroundColor]': 'isLoading ? "transparent" : ""'
  //  }, // Set background color to transparent when loading
  animations: [fadeInOutAnimation]
})
export class AppComponent implements OnInit, OnDestroy, AfterViewInit {
  private destroyRef = inject(DestroyRef)
  private heartbeatService = inject(HeartbeatService)
  @ViewChild(SnackbarComponent) snackbar!: SnackbarComponent
  @ViewChild(RouterOutlet) outlet?: RouterOutlet
  protected snackbarMessage = ''
  protected snackbarAction = ''
  protected snackbarType: SnackBarType = SnackBarType.info
  protected snackbarDuration = 3000
  protected isBrowser = false

    protected isLoading = signal(false)
    protected showRouteLoader = signal(false)
    protected route = signal('/')
    protected authReady = signal(false)

  private readonly loaderDelayMs = 120
  private readonly loaderMinVisibleMs = 220
  private loaderDelaySubscription: Subscription | null = null
  private loaderHideSubscription: Subscription | null = null
  private loaderShownAt = 0
  private hasViewInitialized = false

  constructor(
    @Inject(PLATFORM_ID) private platformId: Object,
    private matIconRegistry: SvgIconService,
    private router: Router,
    private http: HttpClient,
    private theme: ThemeToggleComponent,
    private snackbarService: SnackbarService,
    private authService: AuthService,
    private ngswUpdate: NgswUpdateService,
    private analyticsService: AnalyticsService,
    sessionTimeoutService: SessionTimeoutService, // Auto-initialized via constructor
    deviceVerificationService: DeviceVerificationService // Auto-initialized via constructor
    // Inject ActivatedRoute to access route data
    // private activatedRoute: ActivatedRoute,
  ) {
    // Suppress unused service warnings - services auto-initialize via their constructors
    void sessionTimeoutService
    void deviceVerificationService
    
    this.isBrowser = isPlatformBrowser(this.platformId)

    //Called after ngAfterContentInit when the component's view has been initialized. Applies to components only.
    //Add 'implements AfterViewInit' to the class.
    this.router.events
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        tap((event) => {
          if (event instanceof NavigationStart) {
            this.beginRouteLoading()
          } else if (event instanceof NavigationCancel || event instanceof NavigationError) {
            this.endRouteLoading()
          }
        }),
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        tap((event) => {
          this.endRouteLoading()
           this.route.set(event.urlAfterRedirects)
        }),
        switchMap((event) =>
          this.analyticsService.trackEvent('page_view', {
            // GA4's own parameter names, so this single emit is as informative as
            // `ScreenTrackingService`'s was. `page` stays because the first-party drain
            // keys `byPage.*` off it (`props.page ?? props.path`).
            page: event.urlAfterRedirects,
            page_location: typeof location !== 'undefined' ? location.href : event.urlAfterRedirects,
            page_title: typeof document !== 'undefined' ? document.title : '',
            timestamp: new Date().toISOString()
          }).pipe(
            catchError((error) => {
              console.error('Error tracking page view event:', error)
              return of(null)
            })
          )
        )
      )
      .subscribe()

    // Register SVG resolver for both browser and SSR so MatIcon can resolve named icons consistently.
    this.matIconRegistry.addSvgIconResolver()
  }

  get title() {
    return 'deepscrape'
  }

  get token() {
    return this.authService.token
  }
  ngOnInit() {

    if (!this.router.navigated) {
      this.beginRouteLoading()
    } else {
      this.endRouteLoading()
    }

    this.theme.setDefaultTheme()

    const isBrowser = isPlatformBrowser(this.platformId)
    if (isBrowser) {
      this.http.get('/csrf-token', { withCredentials: true })
        .pipe(
          takeUntilDestroyed(this.destroyRef),
          catchError(() => of(null)),
        )
        .subscribe()

    }

    // Make a request to the status endpoint to trigger guestTracker.
    // This needs to run in emulator mode too, otherwise first-login metrics miss guest enrichment.
    if (isBrowser && (environment.production || environment.emulators)) {

      // Started for anonymous visitors as well. The heartbeat skips itself unless the
      // visitor is signed in or granted analytics consent, and its first beat is the
      // only same-origin call that lets `guestTracker` mint a `gid` for a consented
      // visitor who has no identity yet -- without it nobody is ever counted.
      this.heartbeatService.start(this.token)

      // Send custom analytics event to backend
      forkJoin([
        this.analyticsService.sendStatus(),
      ])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ([statusResponse]) => {
          console.log('API Status Check:', statusResponse)
        },
        error: (error) => {
          console.error('Error checking API status or sending analytics event:', error)
        }
      })
      
    
    }

  }


  ngAfterViewInit() {
    this.hasViewInitialized = true
    

      // Resolve Firebase Auth state before rendering the router outlet
      this.authService.isAuthenticated()
        .pipe(take(1), takeUntilDestroyed(this.destroyRef))
        .subscribe(() => this.authReady.set(true))

      this.snackbarService.setSnackbar(this.snackbar)
  }

  onSnackbarAction() {
    // console.log('Snackbar action clicked')
  }

  onSnackbarClose() {
    // console.log('Snackbar closed')
  }

  // Helper method to get the animation data from the router outlet
  getRouteAnimationData(outlet?: RouterOutlet | null) {
    return outlet && outlet.activatedRouteData && outlet.activatedRouteData['animation'] || 'initial'
  }

  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.
    this.loaderDelaySubscription?.unsubscribe()
    this.loaderDelaySubscription = null

    this.loaderHideSubscription?.unsubscribe()
    this.loaderHideSubscription = null

    this.heartbeatService.stop() // Stop heartbeat when app is destroyed
  }

  private beginRouteLoading(): void {
    if (!this.isBrowser) {
      return
    }

      this.isLoading.set(true)

    if (!this.hasViewInitialized) {
      return
    }

    this.loaderHideSubscription?.unsubscribe()
    this.loaderHideSubscription = null

    this.loaderDelaySubscription?.unsubscribe()

    this.loaderDelaySubscription = timer(this.loaderDelayMs)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (!this.isLoading()) {
        return
      }

        this.showRouteLoader.set(true)
      this.loaderShownAt = Date.now()
    })
  }

  private endRouteLoading(): void {
    if (!this.isBrowser) {
      return
    }

      this.isLoading.set(false)

    if (!this.hasViewInitialized) {
        this.showRouteLoader.set(false)
      return
    }

    this.loaderDelaySubscription?.unsubscribe()
    this.loaderDelaySubscription = null

      if (!this.showRouteLoader()) {
      return
    }

    const visibleFor = Date.now() - this.loaderShownAt
    const remaining = Math.max(0, this.loaderMinVisibleMs - visibleFor)

    this.loaderHideSubscription?.unsubscribe()

    this.loaderHideSubscription = timer(remaining)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (!this.isLoading()) {
          this.showRouteLoader.set(false)
      }
    })
  }

}
