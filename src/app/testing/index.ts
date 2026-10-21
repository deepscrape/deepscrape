/**
 * Central testing utilities for deepscrape Angular specs.
 *
 * Usage in spec files:
 *   import { getTestProviders } from 'src/app/testing';
 *   TestBed.configureTestingModule({ providers: getTestProviders() });
 *   // or for components:
 *   TestBed.configureTestingModule({ imports: [MyComponent], providers: getTestProviders() });
 */

// Load test setup immediately when testing module is imported
// This ensures console.error spy is set up in beforeEach for all tests
import 'src/test-setup';

import { ChangeDetectorRef, EnvironmentProviders, PLATFORM_ID, Provider } from '@angular/core';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNgxStripe } from 'ngx-stripe';
import { SwUpdate } from '@angular/service-worker';
import { of, EMPTY } from 'rxjs';

// @angular/fire modular tokens
import { Auth } from '@angular/fire/auth';
import { Firestore } from '@angular/fire/firestore';
import { Storage } from '@angular/fire/storage';
import { Analytics } from '@angular/fire/analytics';
import { Functions } from '@angular/fire/functions';
import { Messaging } from '@angular/fire/messaging';
import { Performance } from '@angular/fire/performance';

// Custom app tokens
import { WindowToken } from '../core/services/window.service';
import { BrowserToken } from '../core/services/browser.service';
import { LocalStorage, SessionStorage, NoopStorage } from '../core/services/storage.service';
import { NAVIGATOR } from '../core/providers';
import { CONTROL_NAME } from '../core/services/pack.service';

// Third-party services
import { CookieService } from 'ngx-cookie-service';

// App services (mocked)
import { HeartbeatService } from '../core/services/heartbeat.service';
import { AnalyticsService } from '../core/services/analytics.service';
import { AuthService } from '../core/services/auth.service';
import { FirestoreService } from '../core/services/firestore.service';
import { CartService } from '../core/services/cart.service';
import { ApiKeyService } from '../core/services/apikey.service';
import { NgswUpdateService } from '../core/services/ngsw-update.service';
import { ScreenResizeService } from '../core/services/screen-resize.service';
import { SnackbarService } from '../core/services/snackbar.service';
import { SeedingService } from '../core/services/seeding.service';
import { OperationStatusService } from '../core/services/operation-status.service';
import { AppUserLayoutComponent } from '../layout/full/app-user-layout/app-user-layout.component';
import { TranslateService } from '@ngx-translate/core';

// Re-export for convenience
export { HttpTestingController } from '@angular/common/http/testing';

// ---------------------------------------------------------------------------
// Minimal stub objects
// ---------------------------------------------------------------------------

/** Minimal Firebase Auth stub */
const mockAuth = {
  currentUser: null,
  onAuthStateChanged: (_cb: unknown) => () => {},
  signInWithEmailAndPassword: () => Promise.resolve(),
  signOut: () => Promise.resolve(),
  app: { options: {} },
};

/** Minimal Firebase Firestore stub */
const mockFirestore = {
  collection: () => ({}),
  doc: () => ({}),
  app: { options: {} },
};

/** Minimal Firebase Storage stub */
const mockStorage = {
  ref: () => ({}),
  app: { options: {} },
  maxUploadRetryTime: 0,
  maxOperationRetryTime: 0,
};

/** Minimal CookieService stub */
const mockCookieService = {
  get: () => '',
  getAll: () => ({}),
  set: () => {},
  delete: () => {},
  deleteAll: () => {},
  check: () => false,
};

/** Minimal HeartbeatService stub */
const mockHeartbeatService = {
  start: () => {},
  stop: () => {},
  beat: () => {},
};

/** Minimal AnalyticsService stub */
const mockAnalyticsService = {
  trackEvent: () => of(null),
  logEvent: () => of(null),
  setUser: () => {},
  track: () => of(null),
  batchTrackEvents: () => of(null),
  sendStatus: () => of({ ok: true }),
};

const mockFirestoreService = {
  getInstanceDB: () => ({}),
  authState: () => of(null),
  getUserData: () => Promise.resolve(null),
  setUserData: () => Promise.resolve(true),
  updateLoginMetrics: () => Promise.resolve(true),
  checkDomainValidity: () => Promise.resolve({ valid: true }),
  loadPreviousPacks: () => Promise.resolve([]),
  callFunction: () => Promise.resolve({ error: false, machines: [], inTotal: 0, totalPages: 1 }),
};

const mockAuthService = {
  token: undefined,
  isAdmin: false,
  userSubject: { value: null, next: () => {} },
  user$: of(null),
  // `SessionTimeoutService` subscribes to this at construction: a mock without it throws
  // `Cannot read properties of undefined (reading 'pipe')` from whichever component
  // happens to inject the timeout service.
  sessionExpiresAt$: of(null),
  isAuthenticated: () => of({ isAuthenticated: false, user: null }),
  getEnrolledMultiFactorHints: () => [],
  signOut: () => Promise.resolve(),
};

const mockTranslateService = {
  currentLang: 'en',
  defaultLang: 'en',
  getBrowserLang: () => 'en',
  use: (_lang: string) => of('en'),
  instant: (key: string) => key,
  get: (key: string) => of(key),
  stream: (key: string) => of(key),
  // Members required by the TranslatePipe (ngx-translate v17) so specs that
  // render templates using `| translate` do not throw. Values resolve to the
  // key path, matching the instant/get contract used across the suite.
  getCurrentLang: () => 'en',
  getFallbackLang: () => 'en',
  getParsedResult: (key: string) => key,
  onLangChange: of({ lang: 'en', translations: {} }),
  onTranslationChange: of({ lang: 'en', translations: {} }),
  onDefaultLangChange: of({ lang: 'en', translations: {} }),
  onFallbackLangChange: of({ lang: 'en', translations: {} }),
};

const mockCartService = {
  cartPackItem$: of(null),
  getCart$: of(null),
  addToCart: () => {},
  removeFromCart: () => {},
  clearCart: () => {},
};

const mockApiKeyService = {
  setMenuInVisible: () => {},
  apiKeys$: of([]),
};

const mockAppUserLayout = {
  onCloseAsideBar: () => {},
  // AppSidebarNavLinkComponent reads this as a signal; mirrors the real component's `selectedOrgId`.
  selectedOrgId: () => null,
};

/** Minimal SwUpdate stub (service worker disabled in tests) */
const mockSwUpdate = {
  isEnabled: false,
  versionUpdates: EMPTY,
  activateUpdate: () => Promise.resolve(false),
  checkForUpdate: () => Promise.resolve(false),
};

/** Minimal NgswUpdateService stub */
const mockNgswUpdateService = {};

/** Minimal ScreenResizeService stub */
const mockScreenResizeService = {
  onResize$: EMPTY,
  updateScreenSize: () => ({ screenWidth: 1280, screenHeight: 720 }),
  onResize: () => {},
};

/** Minimal SnackbarService stub */
const mockSnackbarService = {
  setSnackbar: () => {},
  showSnackbar: () => {},
};

/** Minimal SeedingService stub */
const mockSeedingService = {
  multiSeedEnqueue: () => EMPTY,
  cancelTask: () => EMPTY,
};

/** Minimal OperationStatusService stub */
const mockOperationStatusService = {
  getTaskStatusWithSnackbar: () => EMPTY,
};

// ---------------------------------------------------------------------------
// Main provider factory
// ---------------------------------------------------------------------------

/**
 * Returns a flat array of providers/environment-providers suitable for
 * `TestBed.configureTestingModule({ providers: getTestProviders() })`.
 *
 * Provides mocks for every Firebase service, custom injection tokens,
 * HttpClient (with testing controller), Router, and common app services
 * so that components and services can be instantiated without real Firebase.
 */
export function getTestProviders(): (Provider | EnvironmentProviders)[] {
  const noopStorage = new NoopStorage();
  const testStripePublishableKey = 'pk_test_deepscrape_testing_key';

  return [
    // --- Angular internals ---
    provideZonelessChangeDetection(),
    provideAnimations(),
    provideRouter([]),
    provideHttpClient(withFetch()),
    provideHttpClientTesting(),
    provideNgxStripe(testStripePublishableKey),

    // --- Platform---
    { provide: PLATFORM_ID, useValue: 'browser' },

    // --- Firebase mocks ---
    { provide: Auth, useValue: mockAuth },
    { provide: Firestore, useValue: mockFirestore },
    { provide: Storage, useValue: mockStorage },
    { provide: Analytics, useValue: null },
    { provide: Functions, useValue: null },
    { provide: Messaging, useValue: null },
    { provide: Performance, useValue: null },

    // --- Custom tokens ---
    { provide: WindowToken, useValue: window },
    { provide: NAVIGATOR, useValue: window.navigator },
    { provide: BrowserToken, useValue: {} },
    { provide: LocalStorage, useValue: noopStorage },
    { provide: SessionStorage, useValue: noopStorage },
    { provide: CONTROL_NAME, useValue: 'test-control' },

    // --- Third-party service mocks ---
    { provide: CookieService, useValue: mockCookieService },

    // --- App service mocks ---
    { provide: HeartbeatService, useValue: mockHeartbeatService },
    { provide: AnalyticsService, useValue: mockAnalyticsService },
    { provide: FirestoreService, useValue: mockFirestoreService },
    { provide: AuthService, useValue: mockAuthService },
    { provide: TranslateService, useValue: mockTranslateService },
    { provide: CartService, useValue: mockCartService },
    { provide: ApiKeyService, useValue: mockApiKeyService },
    { provide: SwUpdate, useValue: mockSwUpdate },
    { provide: NgswUpdateService, useValue: mockNgswUpdateService },
    { provide: ScreenResizeService, useValue: mockScreenResizeService },
    { provide: SnackbarService, useValue: mockSnackbarService },
    { provide: SeedingService, useValue: mockSeedingService },
    { provide: OperationStatusService, useValue: mockOperationStatusService },
    { provide: AppUserLayoutComponent, useValue: mockAppUserLayout },

    // ChangeDetectorRef is a VIEW-level provider. A spec that builds a component with
    // `new X()` inside runInInjectionContext sees only the environment injector, so it
    // would throw NG0201. This no-op covers exactly that case; components created via
    // TestBed.createComponent still get the real one from their own view injector.
    { provide: ChangeDetectorRef, useValue: { markForCheck: () => {}, detectChanges: () => {} } },
  ];
}
