import { inject, Injectable, signal, computed, Signal, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CookieService } from 'ngx-cookie-service';
import { cleanAndParseJSON, getBrowser, getDeviceFingerprintHash, getDeviceSignalsHash } from 'src/app/core/functions';
import { Guest, loginHistoryInfo } from '../types';
import { DeviceVerificationService } from './device-verification.service';
import { FirestoreService } from './firestore.service';
import { LocalStorage } from './storage.service';
import { WindowToken } from './window.service';

type AidCookiePayload = {
  guestId?: string;
  loginId?: string;
  userId?: string;
};

type LastLoginHint = {
  providerId: string;
  providerLabel: string;
  maskedIdentifier: string;
  updatedAt: string;
};

const LAST_LOGIN_HINT_KEY = 'last_login_hint';

type SessionTrackingState = {
  guestFingerprint: string | null;
  guestId: string | null;
  loginId: string | null;
  userId: string | null;
};

type PostLoginOptions = {
  force?: boolean;
  providerId: string;
  userId: string;
};

type PostLoginSessionResult = {
  loginId: string;
  userId: string;
};

type ResolvedSessionMetrics = {
  ip: string;
  location: string;
  region: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
};

/**
 * Centralises guest-session state that was previously scattered across AuthService.
 *
 * The BFF writes an `aid` cookie containing `{ guestId, userId, loginId }` as JSON.
 * This service reads it once (on first access) and exposes reactive signals.
 */
@Injectable({ providedIn: 'root' })
export class GuestTrackingService {
  private readonly cookieService = inject(CookieService);
  private readonly deviceVerification = inject(DeviceVerificationService);
  private readonly firestoreService = inject(FirestoreService);
  private readonly localStorage = inject(LocalStorage);
  private readonly platformId = inject<object>(PLATFORM_ID);
  private readonly window = inject(WindowToken);

  // ── internal writable signals ────────────────────────────────────────────
  private readonly _guestId = signal<string | null>(null);
  private readonly _loginId = signal<string | null>(null);
  private readonly _guestFingerprint = signal<string | null>(null);
  private readonly _userId = signal<string | null>(null);
  private readonly sessionInitPromises = new Map<string, Promise<void>>();
  private readonly initializedUsers = new Set<string>();

  // ── public read-only signals ─────────────────────────────────────────────
  readonly guestId: Signal<string | null> = this._guestId.asReadonly();
  readonly loginId: Signal<string | null> = this._loginId.asReadonly();
  readonly guestFingerprint: Signal<string | null> = this._guestFingerprint.asReadonly();
  readonly userId: Signal<string | null> = this._userId.asReadonly();
  readonly hasGuest = computed(() => this._guestId() !== null);

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      this.parseAidCookie();
    }
  }

  /**
   * Parse the BFF-written `aid` cookie and populate signals.
   * Called automatically in the browser; safe to call again after cookie refresh.
   */
  parseAidCookie(): void {
    this.refreshTrackingState();
  }

  refreshTrackingState(): SessionTrackingState {
    if (!isPlatformBrowser(this.platformId)) {
      return {
        guestFingerprint: this._guestFingerprint(),
        guestId: this._guestId(),
        loginId: this._loginId(),
        userId: this._userId(),
      };
    }

    const rawAid = this.cookieService.get('aid');
    const parsed = cleanAndParseJSON(rawAid || '{}') as AidCookiePayload;
    const guestIdFromCookie = this.cookieService.get('gid') || null;
    const guestFingerprint = this.cookieService.get('guest_fp') || null;
    const guestId = parsed?.guestId || guestIdFromCookie || null;
    const loginId = parsed?.loginId || this.localStorage.getItem('loginId') || null;
    const userId = parsed?.userId || null;

    this._guestId.set(guestId);
    this._loginId.set(loginId);
    this._guestFingerprint.set(guestFingerprint);
    this._userId.set(userId);

    return {
      guestFingerprint,
      guestId,
      loginId,
      userId,
    };
  }

  getSessionContext(): SessionTrackingState {
    return this.refreshTrackingState();
  }

  rememberLastLogin(providerId: string, identifier?: string | null): void {
    if (!isPlatformBrowser(this.platformId) || !providerId) {
      return;
    }

    const hint: LastLoginHint = {
      providerId,
      providerLabel: this.toProviderLabel(providerId),
      maskedIdentifier: this.maskIdentifier(identifier),
      updatedAt: new Date().toISOString(),
    };

    this.localStorage.setItem(LAST_LOGIN_HINT_KEY, JSON.stringify(hint));
  }

  getLastLoginHint(): LastLoginHint | null {
    if (!isPlatformBrowser(this.platformId)) {
      return null;
    }

    const rawHint = this.localStorage.getItem(LAST_LOGIN_HINT_KEY);
    const parsed = cleanAndParseJSON(rawHint || '{}') as Partial<LastLoginHint>;
    if (!parsed?.providerId) {
      return null;
    }

    return {
      providerId: String(parsed.providerId),
      providerLabel: String(parsed.providerLabel || this.toProviderLabel(String(parsed.providerId))),
      maskedIdentifier: String(parsed.maskedIdentifier || ''),
      updatedAt: String(parsed.updatedAt || ''),
    };
  }

  /**
   * Link the current guest session to the authenticated user.
   * Delegates to FirestoreService which calls the backend function.
   */
  async linkGuestToUser(uid: string): Promise<void> {
    const guestId = this.refreshTrackingState().guestId;
    if (!guestId || !uid) return;

    try {
      await this.firestoreService.linkGuestToUser(uid, guestId);
    } catch (err) {
      console.warn('[GuestTrackingService] Could not link guest to user:', err);
    }
  }

  async ensurePostLoginSession(options: PostLoginOptions): Promise<PostLoginSessionResult | null> {
    const { userId, providerId, force = false } = options;

    if (!isPlatformBrowser(this.platformId) || !userId || !providerId) {
      return null;
    }

    const state = this.refreshTrackingState();
    if (!force && state.userId === userId && state.loginId) {
      this.initializedUsers.add(userId);
      return {
        loginId: state.loginId,
        userId,
      };
    }

    if (!force && this.initializedUsers.has(userId)) {
      const refreshedState = this.refreshTrackingState();
      return refreshedState.loginId
        ? { loginId: refreshedState.loginId, userId }
        : null;
    }

    const existingPromise = this.sessionInitPromises.get(userId);
    if (!force && existingPromise) {
      await existingPromise;
      const refreshedState = this.refreshTrackingState();
      return refreshedState.loginId
        ? { loginId: refreshedState.loginId, userId }
        : null;
    }

    const sessionPromise = this.recordPostLoginSession(userId, providerId)
      .finally(() => this.sessionInitPromises.delete(userId));

    this.sessionInitPromises.set(userId, sessionPromise);
    await sessionPromise;

    const refreshedState = this.refreshTrackingState();
    if (!refreshedState.loginId) {
      throw new Error('[GuestTrackingService] Post-login session init completed without loginId.');
    }

    return {
      loginId: refreshedState.loginId,
      userId,
    };
  }

  private async recordPostLoginSession(userId: string, providerId: string): Promise<void> {
    const state = this.refreshTrackingState();
    let guestInfo: Guest | null = null;
    let effectiveGuestId = state.guestId;

    if (effectiveGuestId) {
      const { err, guestInfo: linkedGuestInfo } = await this.firestoreService.linkGuestToUser(userId, effectiveGuestId);
      guestInfo = linkedGuestInfo;
      effectiveGuestId = linkedGuestInfo?.id || effectiveGuestId;

      if (err) {
        console.warn('[GuestTrackingService] Guest link skipped due to recoverable error:', err);
      }

      this.setAidCookie({
        guestId: effectiveGuestId,
        userId,
      });
      this.cookieService.delete('gid', '/');
    }

    const navigatorRef = this.window.navigator;
    const browser = await getBrowser(navigatorRef) || 'Unknown';
    const userAgent = navigatorRef?.userAgent || 'Unknown';
    const deviceType = navigatorRef?.platform || 'Unknown';
    // The guest fingerprint stays a risk signal — it is guest-scoped and drifts.
    const deviceFingerprintHash = await getDeviceFingerprintHash(state.guestFingerprint, this.window);
    // ponytail: identity, not entropy. The old fallback was
    // `${deviceType}-${browser}-${Date.now()}` — a NEW id on every login, so
    // `trusted_devices/{deviceId}` could never match and the user re-verified forever.
    // This is the same persisted id DeviceVerificationService already owns.
    const deviceId = this.deviceVerification.getOrCreateDeviceId();

    const metrics: Partial<loginHistoryInfo> = {
      ipAddress: '0.0.0.0',
      browser,
      os: this.detectOsFromUserAgent(userAgent),
      userAgent,
      location: 'Unknown',
      deviceType,
      connection: (navigatorRef as any)?.connection?.effectiveType || null,
      providerId,
      deviceFingerprintHash,
    };

    // Create login session using new Cloud Function (enterprise architecture)
    try {
      const sessionResult = await this.firestoreService.callFunction<
        {
          userId: string;
          deviceId: string;
          metrics: any;
        },
        { success: boolean; sessionId: string; expiresAt: string; resolvedMetrics?: ResolvedSessionMetrics }
      >('createLoginSession', {
        userId,
        deviceId,
        metrics: {
          ip: '0.0.0.0',
          userAgent,
          browser,
          os: this.detectOsFromUserAgent(userAgent),
          location: 'Unknown',
          providerId,
          // Risk signal, not identity: the server stores it on the session and only ever
          // warns / steps up when it changes.
          deviceSignals: await getDeviceSignalsHash(this.window),
        },
      });

      if (sessionResult?.success && sessionResult?.sessionId) {
        console.log('[GuestTrackingService] Created enterprise session:', sessionResult.sessionId);
        const resolvedMetrics = sessionResult.resolvedMetrics;
        const metricsForProjection: loginHistoryInfo = {
          ...(metrics as loginHistoryInfo),
          ipAddress: resolvedMetrics?.ip || (metrics.ipAddress as string) || '0.0.0.0',
          location: resolvedMetrics?.location || (metrics.location as string) || 'Unknown',
        };

        const currentLogin = await this.firestoreService.setUserLoginMetrics(
          userId,
          metricsForProjection,
          guestInfo || undefined,
          sessionResult.sessionId,
        );

        if (currentLogin?.success && currentLogin?.loginId) {
          this.persistAuthenticatedSession({
            guestId: effectiveGuestId || undefined,
            loginId: currentLogin.loginId,
            userId,
          });
          this.initializedUsers.add(userId);
          return;
        }
      }

      throw new Error('[GuestTrackingService] Session created but login metrics did not return loginId.');
    } catch (err) {
      console.warn('[GuestTrackingService] Enterprise session creation failed, using legacy metrics:', err);
      // Fallback to legacy metrics write
      const currentLogin = await this.firestoreService.setUserLoginMetrics(userId, metrics as loginHistoryInfo, guestInfo || undefined);

      if (currentLogin?.success && currentLogin?.loginId) {
        this.persistAuthenticatedSession({
          guestId: effectiveGuestId || undefined,
          loginId: currentLogin.loginId,
          userId,
        });
        this.initializedUsers.add(userId);
        return;
      }

      throw new Error('[GuestTrackingService] Legacy post-login metrics failed to produce loginId.');
    }
  }

  persistAuthenticatedSession(payload: AidCookiePayload): void {
    if (payload.loginId) {
      this.localStorage.setItem('loginId', payload.loginId);
    }

    this.setAidCookie(payload);
  }

  private setAidCookie(payload: AidCookiePayload): void {
    const current = cleanAndParseJSON(this.cookieService.get('aid') || '{}') as AidCookiePayload;
    const nextPayload: AidCookiePayload = {
      ...current,
      ...payload,
    };

    this.cookieService.set('aid', JSON.stringify(nextPayload), 90, '/', '', true, 'Lax');
    this._guestId.set(nextPayload.guestId || null);
    this._loginId.set(nextPayload.loginId || null);
    this._userId.set(nextPayload.userId || null);
  }

  private detectOsFromUserAgent(userAgent: string): string {
    const ua = (userAgent || '').toLowerCase();
    if (ua.includes('windows')) return 'Windows';
    if (ua.includes('mac os') || ua.includes('macintosh')) return 'macOS';
    if (ua.includes('android')) return 'Android';
    if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) return 'iOS';
    if (ua.includes('linux')) return 'Linux';
    return 'Unknown';
  }

  private toProviderLabel(providerId: string): string {
    switch (providerId) {
      case 'google.com':
        return 'Google';
      case 'github.com':
        return 'GitHub';
      case 'password':
        return 'Password';
      case 'phone':
        return 'Phone';
      default:
        return providerId.replace('.com', '');
    }
  }

  private maskIdentifier(identifier?: string | null): string {
    const value = String(identifier || '').trim();
    if (!value) {
      return '';
    }

    if (value.includes('@')) {
      const [localPart, domain] = value.split('@');
      const visibleLocal = localPart.slice(0, 2);
      return `${visibleLocal}${'*'.repeat(Math.max(localPart.length - visibleLocal.length, 1))}@${domain}`;
    }

    if (value.startsWith('+')) {
      const tail = value.slice(-4);
      return `•••• ${tail}`;
    }

    const visible = value.slice(0, 2);
    return `${visible}${'*'.repeat(Math.max(value.length - visible.length, 2))}`;
  }

  /** Reset persisted and in-memory auth tracking state. */
  clear(): void {
    this.localStorage.removeItem('loginId');
    this.cookieService.delete('aid', '/');
    this._guestId.set(null);
    this._loginId.set(null);
    this._guestFingerprint.set(null);
    this._userId.set(null);
    this.initializedUsers.clear();
    this.sessionInitPromises.clear();
  }
}
