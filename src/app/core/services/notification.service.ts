import { Injectable, Injector, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { environment } from 'src/environments/environment';

// `firebase/messaging` is reached through a dynamic import (see loadMessaging), so the
// FCM SDK is not part of the initial bundle — it is only needed after the user opts in.
type MessagingModule = typeof import('firebase/messaging');
// The app SDK is loaded the same way, and for a specific reason: see resolveMessagingApp.
type AppModule = typeof import('firebase/app');

/**
 * Web-push (Firebase Cloud Messaging) opt-in for the current user.
 *
 * Design notes:
 * - `Messaging` is resolved from the Injector *inside* browser-guarded methods, never
 *   in a field initializer. `getMessaging()` touches `navigator`/service workers, so
 *   injecting it during SSR would break server rendering of any component that
 *   happens to inject this service.
 * - Tokens are stored server-side by a callable (`registerNotificationToken`), so the
 *   client needs no Firestore write permission on the token subcollection.
 * - Push permission is only ever requested from an explicit user gesture. Requesting
 *   on load triggers Chrome's abusive-notification heuristics and gets auto-denied.
 */

export type PushState =
  | 'unsupported'   // no Notification API / no service worker support
  | 'unconfigured'  // missing FIREBASE_VAPID_KEY in this build
  | 'default'       // supported, permission not yet asked
  | 'blocked'       // user denied at the browser level
  | 'subscribed'    // permission granted and this device has a registered token
  | 'error';

export type ForegroundPush = {
  title: string;
  body: string;
  link?: string;
};

const SUBSCRIBED_FLAG = 'deepscrape.push.subscribed';
// Must match the scope the service worker is registered with below; Firebase
// requires a custom scope when the site already has a service worker at '/'.
const PUSH_SW_SCOPE = '/firebase-cloud-messaging-push-scope';
const PUSH_SW_URL = '/firebase-messaging-sw.js';

// The generated `environment.ts` (dev) and the checked-in `prod.ts`/`staging.ts`
// are separate files, so the key is optional by construction: builds that have not
// supplied it report 'unconfigured' instead of throwing.
const vapidKey = (environment as { FIREBASE_VAPID_KEY?: string }).FIREBASE_VAPID_KEY || '';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly injector = inject(Injector);
  private readonly platformId = inject(PLATFORM_ID);

  private readonly state = signal<PushState>('default');
  private readonly busyState = signal(false);
  private readonly errorState = signal<string | null>(null);
  private readonly deviceCount = signal(0);
  private readonly foregroundState = signal<ForegroundPush | null>(null);
  private unsubscribeMessages: (() => void) | null = null;
  private messagingModule: Promise<MessagingModule> | null = null;
  private appModule: Promise<AppModule> | null = null;
  private messagingApp: Promise<Awaited<ReturnType<AppModule['initializeApp']>>> | null = null;

  /** Current push state; drive the toggle's label/disabled state from this. */
  readonly status = this.state.asReadonly();
  /** True while a permission request / token round-trip is in flight. */
  readonly busy = this.busyState.asReadonly();
  /** Last user-facing error, cleared on the next attempt. */
  readonly error = this.errorState.asReadonly();
  /** Number of devices with push enabled for this user (server-reported). */
  readonly devices = this.deviceCount.asReadonly();
  /** Most recent message received while the app was in the foreground. */
  readonly foreground = this.foregroundState.asReadonly();

  readonly isSubscribed = computed(() => this.state() === 'subscribed');

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      void this.sync();
    } else {
      this.state.set('unsupported');
    }
  }

  /**
   * Reconcile local state with the browser and the server on startup.
   *
   * Also covers FCM token rotation: a token that changed since the last visit is
   * re-registered, otherwise push silently stops working for that device.
   */
  async sync(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) return;

    if (!this.isSupported()) {
      this.state.set('unsupported');
      return;
    }

    if (!vapidKey) {
      this.state.set('unconfigured');
      return;
    }

    const permission = Notification.permission;
    if (permission === 'denied') {
      this.state.set('blocked');
      return;
    }

    const wasSubscribed = this.readFlag();
    if (permission === 'granted' && wasSubscribed) {
      this.state.set('subscribed');
      this.listenForForegroundMessages();
      await this.refreshDeviceCount();
      await this.reregisterIfTokenRotated();
      return;
    }

    this.state.set(permission === 'granted' ? 'subscribed' : 'default');
  }

  /** Request permission and register this device. Must be called from a user gesture. */
  async enable(): Promise<boolean> {
    if (!isPlatformBrowser(this.platformId)) return false;
    this.errorState.set(null);

    if (!this.isSupported()) {
      this.state.set('unsupported');
      return false;
    }
    if (!vapidKey) {
      this.state.set('unconfigured');
      this.errorState.set('Push is not configured for this build (FIREBASE_VAPID_KEY is missing).');
      return false;
    }

    this.busyState.set(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        this.state.set(permission === 'denied' ? 'blocked' : 'default');
        return false;
      }

      const token = await this.requestToken();
      if (!token) {
        this.state.set('error');
        this.errorState.set('The browser did not return a push token.');
        return false;
      }

      await this.registerTokenOnServer(token);
      this.writeFlag(true);
      this.state.set('subscribed');
      this.listenForForegroundMessages();
      await this.refreshDeviceCount();
      return true;
    } catch (error) {
      this.state.set('error');
      this.errorState.set(this.describe(error));
      return false;
    } finally {
      this.busyState.set(false);
    }
  }

  /** Revoke the token for this device and stop receiving background push. */
  async disable(): Promise<boolean> {
    if (!isPlatformBrowser(this.platformId)) return false;
    this.errorState.set(null);
    this.busyState.set(true);

    try {
      const { getMessaging, getToken, deleteToken } = await this.loadMessaging();
      const messaging = getMessaging(await this.resolveMessagingApp());
      const token = await getToken(messaging, {
        vapidKey,
        serviceWorkerRegistration: await this.getRegistration(),
      }).catch(() => null);

      if (token) {
        await this.call('unregisterNotificationToken', { token }).catch(() => undefined);
      }
      await deleteToken(messaging).catch(() => false);

      this.stopForegroundListener();
      this.writeFlag(false);
      this.state.set('default');
      await this.refreshDeviceCount();
      return true;
    } catch (error) {
      this.errorState.set(this.describe(error));
      return false;
    } finally {
      this.busyState.set(false);
    }
  }

  /** Send a push to the caller's own devices, to prove the loop end to end. */
  async sendTest(): Promise<{ sent: number; attempted: number } | null> {
    try {
      const result = await this.call<{ sent: number; attempted: number }>('sendTestNotification', {});
      return result;
    } catch (error) {
      this.errorState.set(this.describe(error));
      return null;
    }
  }

  /** Dismiss the last foreground message once the UI has shown it. */
  clearForeground(): void {
    this.foregroundState.set(null);
  }

  private isSupported(): boolean {
    return typeof Notification !== 'undefined' && 'serviceWorker' in navigator;
  }

  private readFlag(): boolean {
    try {
      return localStorage.getItem(SUBSCRIBED_FLAG) === '1';
    } catch {
      return false;
    }
  }

  private writeFlag(value: boolean): void {
    try {
      if (value) localStorage.setItem(SUBSCRIBED_FLAG, '1');
      else localStorage.removeItem(SUBSCRIBED_FLAG);
    } catch {
      // Private mode / storage disabled: the server remains the source of truth.
    }
  }

  private async getRegistration(): Promise<ServiceWorkerRegistration> {
    return navigator.serviceWorker.register(PUSH_SW_URL, { scope: PUSH_SW_SCOPE });
  }

  /** Cached dynamic import — the FCM SDK loads once, on the first opt-in. */
  private loadMessaging(): Promise<MessagingModule> {
    this.messagingModule ||= import('firebase/messaging');
    return this.messagingModule;
  }

  /** Cached dynamic import of the app SDK, resolved inside this module's graph. */
  private loadApp(): Promise<AppModule> {
    this.appModule ||= import('firebase/app');
    return this.appModule;
  }

  /**
   * Resolve a Firebase app the FCM SDK will actually accept.
   *
   * `getMessaging()` with no argument looks up the *default* app in its own module registry,
   * and this build ships two copies of `@firebase/app`: one in the initial bundle, where
   * `provideFirebaseApp` registers the default app, and one pulled in with the lazily imported
   * FCM chunk. The lookup therefore finds nothing and throws `app/no-app` — after the
   * permission prompt has already been answered, which is why the browser reports that
   * notifications are on while the device is never registered and no push arrives.
   *
   * Resolving the app here pairs it with the copy messaging loaded: if `firebase/app` resolves
   * to the same copy the initial bundle already initialised, `getApp()` returns that one;
   * otherwise the app is created in this copy. Either way app and SDK agree.
   *
   * @return {Promise<FirebaseApp>} An app from the same module instance as the FCM SDK.
   */
  private resolveMessagingApp(): Promise<Awaited<ReturnType<AppModule['initializeApp']>>> {
    this.messagingApp ||= (async () => {
      const { getApp, getApps, initializeApp } = await this.loadApp();
      return getApps().length ? getApp() : initializeApp(environment.firebaseConfig);
    })();

    return this.messagingApp;
  }

  private async requestToken(): Promise<string | null> {
    const { getMessaging, getToken } = await this.loadMessaging();
    return getToken(getMessaging(await this.resolveMessagingApp()), {
      vapidKey,
      serviceWorkerRegistration: await this.getRegistration(),
    });
  }

  private async registerTokenOnServer(token: string): Promise<void> {
    await this.call('registerNotificationToken', {
      token,
      platform: this.platformLabel(),
      userAgent: navigator.userAgent.slice(0, 300),
      enabled: true,
    });
  }

  private async reregisterIfTokenRotated(): Promise<void> {
    const current = await this.requestToken().catch(() => null);
    if (!current) return;
    // The server upserts by token hash, so re-registering an unchanged token is a
    // cheap merge rather than a duplicate — this keeps rotation recovery simple.
    await this.registerTokenOnServer(current).catch(() => undefined);
  }

  private async refreshDeviceCount(): Promise<void> {
    const result = await this.call<{ count: number }>('getMyNotificationTokens', {})
      .catch(() => null);
    if (result) this.deviceCount.set(result.count);
  }

  private listenForForegroundMessages(): void {
    if (this.unsubscribeMessages) return;
    // Fire-and-forget: the module is already cached from the opt-in path, and a
    // failure to attach the handler must not block the caller.
    void this.loadMessaging()
      .then(async ({ getMessaging, onMessage }) => {
        this.unsubscribeMessages = onMessage(getMessaging(await this.resolveMessagingApp()), (payload) => {
          const notification = payload.notification || {};
          this.foregroundState.set({
            title: notification.title || 'deepscrape',
            body: notification.body || '',
            link: (payload.fcmOptions as { link?: string } | undefined)?.link || payload.data?.['link'],
          });
        });
      })
      .catch(() => undefined);
  }

  private stopForegroundListener(): void {
    this.unsubscribeMessages?.();
    this.unsubscribeMessages = null;
  }

  private async call<T>(name: string, data: unknown): Promise<T> {
    // No explicit Auth needed: the Firebase SDK attaches the current user's ID token
    // to callables automatically.
    const functions = this.injector.get(Functions);
    const callable = httpsCallable<unknown, T>(functions, name);
    const result = await callable(data);
    return result.data;
  }

  private platformLabel(): string {
    const ua = navigator.userAgent;
    if (/android/i.test(ua)) return 'android-web';
    if (/iphone|ipad|ipod/i.test(ua)) return 'ios-web';
    return 'web';
  }

  private describe(error: unknown): string {
    if (error instanceof Error) return error.message;
    return 'Push notifications could not be updated.';
  }
}
