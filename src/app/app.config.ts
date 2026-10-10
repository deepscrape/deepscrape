import { ApplicationConfig, isDevMode, importProvidersFrom, provideZonelessChangeDetection, inject } from '@angular/core';
import { provideRouter, TitleStrategy } from '@angular/router';

import { routes } from './app.routes';
import { DomSanitizer, provideClientHydration, withEventReplay, withHttpTransferCacheOptions, withIncrementalHydration } from '@angular/platform-browser';
import { provideServiceWorker } from '@angular/service-worker';
import { FirebaseApp, getApp, initializeApp, provideFirebaseApp } from '@angular/fire/app';
import { connectFirestoreEmulator, getFirestore, provideFirestore } from '@angular/fire/firestore';
import { connectFunctionsEmulator, getFunctions, provideFunctions } from '@angular/fire/functions';
import { getStorage, provideStorage } from '@angular/fire/storage';
import { provideAnalytics, getAnalytics, UserTrackingService } from '@angular/fire/analytics';

import { Auth, getAuth, inMemoryPersistence, initializeAuth, provideAuth } from '@angular/fire/auth';
import { LoadingBarHttpClientModule } from '@ngx-loading-bar/http-client';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
// Direct imports rather than the './core/services' barrel: the barrel re-exports every
// root service (including firestore.service), which would retain their modules — and the
// Firebase SDKs they import — in the eager initial bundle.
import { browserProvider, BrowserToken } from './core/services/browser.service';
import { windowProvider, WindowToken } from './core/services/window.service';
import { STORAGE_PROVIDERS } from './core/services/storage.service';
import { provideHttpClient, withFetch, withInterceptors, withInterceptorsFromDi, withXsrfConfiguration } from '@angular/common/http';
import { IMAGE_LOADER, ImageLoaderConfig } from '@angular/common';
import { isPlatformBrowser } from '@angular/common';
import { environment } from 'src/environments/environment';
import { NAVIGATOR_PROVIDER } from './core/providers';
import { LogLevel, setLogLevel } from '@angular/fire';
import { LUCIDE_ICONS, LucideIconProvider } from 'lucide-angular';
// Direct import rather than the './shared' barrel (which re-exports notification-bell → Auth + Firestore).
import { myIcons } from './shared/lucideicons'
import { provideI18n } from './core/i18n'; // Import provideI18n
import { csrfRefreshInterceptor, orgContextInterceptor, paymentRequiredInterceptor, sessionRevocationInterceptor } from './core/interceptors';
import { provideHostRouting } from './core/guards/host-routing.guard';
import { SeoTitleStrategy } from './core/services/seo-title.strategy';
import { PLATFORM_ID } from '@angular/core';

setLogLevel(
  environment.production ? LogLevel.SILENT : LogLevel.VERBOSE
)

// Custom image loader that handles both dev and prod
const customImageLoader = (config: ImageLoaderConfig) => {
  const baseUri = environment.assetsUri.endsWith('/') ? environment.assetsUri : environment.assetsUri + '/';
  return baseUri + config.src.replace(/^\//, '');
}

const hydrationProviders = [
  provideClientHydration(
    withIncrementalHydration(),
    withEventReplay(),
    withHttpTransferCacheOptions({
      includePostRequests: true,
    }),
  ),
];

export const appConfig: ApplicationConfig = {
  providers: [
    NAVIGATOR_PROVIDER,
    STORAGE_PROVIDERS,
    { provide: WindowToken, useFactory: windowProvider },
    { provide: BrowserToken, useFactory: browserProvider },
    { provide: LUCIDE_ICONS, multi: true, useValue: new LucideIconProvider(myIcons) }, // Register the LucideIconProvider
    importProvidersFrom(LoadingBarHttpClientModule),
    provideHttpClient(
      withInterceptorsFromDi(),
      withInterceptors([csrfRefreshInterceptor, orgContextInterceptor, sessionRevocationInterceptor, paymentRequiredInterceptor]),
      withXsrfConfiguration({ cookieName: '_csrf', headerName: 'csrf-token' }),
      withFetch(),      
      /* withInterceptors([
        new TokenInterceptor().intercept,
        // new CsrfInterceptor().intercept
      ]), */
    ),    // Custom image loader for dev and prod
    {
      provide: IMAGE_LOADER,
      useValue: customImageLoader
    },

    // provideZoneChangeDetection({ eventCoalescing: true }),
    provideZonelessChangeDetection(),
    provideRouter(routes),
    // Keeps client-side navigations on the origin that owns the target route.
    // The Hosting redirects only cover cold document loads; a routerLink issues
    // no HTTP request, so without this a marketing-page link into `/service/**`
    // would render the app on the apex. See `core/guards/host-routing.policy.ts`.
    provideHostRouting(),
    { provide: TitleStrategy, useClass: SeoTitleStrategy },
    // GA is a third-party processor: loading it sets Google's own `_ga` cookies
    // and starts sending page views, which is the lawful-basis problem the
    // consent banner exists to fix. `guestTracker` in the Cloud Function reads
    // the same cookie, so one choice gates both the first-party guest record and
    // this. Read straight from `document.cookie`: this array is evaluated before
    // any injection context exists, so `inject()` is not available here.
    // ponytail: decided once at bootstrap, so accepting mid-session starts GA on
    // the next page load rather than instantly.
    ...((typeof document !== 'undefined' &&
      document.cookie.split('; ').includes('consent=granted'))
      ? [
          provideAnalytics(() => getAnalytics()),
          // No ScreenTrackingService: it sent its own `page_view` for every navigation on
          // top of the one `AppComponent` already tracks through `AnalyticsService` (which
          // also feeds the first-party fact table), so every page view was counted twice
          // in GA4. One emitter, both pipelines.
          UserTrackingService, // track unique users automatically
        ]
      : []),
    ...hydrationProviders,
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000'
    }),
    provideFirebaseApp(() => initializeApp(environment.firebaseConfig)),
    // Auth needs an explicit persistence outside the browser: with none, `getAuth()` cannot pick
    // one and throws `auth/operation-not-supported-in-this-environment`, once per page — which is
    // what the four errors in a dev build log are. (A dev build runs at `LogLevel.VERBOSE`, which
    // is why they print there and not in production.) In-memory only: the server holds no session,
    // and the seven `/service/**` pages are prerendered precisely so they render as a guest shell.
    //
    // `inject(FirebaseApp)` rather than `getApp()` so DI initialises the app first — the global
    // `getApp()` would throw "No Firebase App '[DEFAULT]' has been created" if it ran first.
    provideAuth(() => {
      if (isPlatformBrowser(inject(PLATFORM_ID))) {
        return getAuth();
      }
      // Server side: a real instance with in-memory persistence. `getAuth()` alone cannot pick a
      // persistence outside the browser, and a `{} as Auth` stub was measured to be *worse* here —
      // it removed none of the errors and added 22 `isAuthenticated` warnings, because downstream
      // code reads `auth.currentUser` on the server. In-memory keeps those reads well-defined.
      return initializeAuth(inject(FirebaseApp), {
        persistence: inMemoryPersistence,
        popupRedirectResolver: undefined,
      });
    }),
    provideFirestore(() =>
    {
      // The named database the app actually uses. `getFirestore()` with no database id
      // resolves to `(default)` — a different database, in a different region — and every
      // consumer of the injected `Firestore` token silently talked to that one instead:
      // NotificationBellComponent listened on `users/{uid}/alerts` there (never firing —
      // alert-fanout writes alerts to `easyscrape`) and FirestoreAnalyticsService read
      // `metrics_*` there (always empty). Services that build their own handle already ask
      // for 'easyscrape'; this makes the injected one agree. The SDK caches per
      // (app, database), so it hands back the same instance the services get, which also
      // means the emulator wiring below applies to the real data path rather than to an
      // unused one.
      const firestore = getFirestore(getApp(), 'easyscrape');
      if (environment.emulators && isPlatformBrowser(inject(PLATFORM_ID))) {
        console.log('🔥 Connecting Firestore to Emulator');
        connectFirestoreEmulator(firestore, 'localhost', 5001);
      }
      return firestore
    }
    ),
    // Required: FirestoreService injects the `Functions` token (optional) and
    // NotificationService resolves it via the injector — both call `httpsCallable`.
    provideFunctions(() => {

      const functions = getFunctions()
      if (environment.emulators && isPlatformBrowser(inject(PLATFORM_ID))) {
        console.log('🔥 Connecting Functions to Emulator');
        connectFunctionsEmulator(functions, 'localhost', 8081)
      }
      return functions;
    }),
    provideStorage(() => getStorage()),
    // Messaging and Performance are intentionally NOT provided here. Both are reached
    // through dynamic `import()` inside NotificationService / PerformanceService, so
    // their SDKs stay out of the initial bundle and load on first use (push opt-in,
    // first trace). Providing them at root would pull both into the eager chunk.
    // ponytail: the App Check client here was dead code — the 'APP_CHECK' string token
    // is never injected by anything (contact.component takes AppCheck with
    // { optional: true }, and provideAppCheck was already commented out), yet this block
    // statically imported the whole App Check SDK into the initial bundle.
    //
    // Removing it left the server enforcing a token the browser never sends, which made
    // every callable declaring `enforceAppCheck: true` fail with UNAUTHENTICATED (session
    // revoke, sign-out, device verification, device removal, MFA preferences).
    // `APP_CHECK_ENFORCED` in functions/src/infrastructure/callable-limiter.ts now gates
    // that, so this file and that constant are the two halves of one switch: re-add
    // provideAppCheck() here FIRST, then flip that constant to true.
    provideAnimationsAsync(),
    provideI18n(), // Add the i18n providers here
  ]
}
