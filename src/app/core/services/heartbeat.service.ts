import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { CookieService } from 'ngx-cookie-service';
import { Subscription, merge, fromEvent, timer, Subject, throwError, Observable, of } from 'rxjs';
import { takeUntil, switchMap, filter, startWith, tap, catchError } from 'rxjs/operators';
import { WindowToken } from './window.service';
import { GuestTrackingService } from './guest-tracking.service';

@Injectable({ providedIn: 'root' })
export class HeartbeatService {

    private window = inject(WindowToken);
    private guestTrackingService = inject(GuestTrackingService, { optional: true });
    private cookieService = inject(CookieService);
    private intervalSub: Subscription | null = null;
    private inactivitySub: Subscription | null = null;
    private isPaused = false;
    private readonly inactivityMs = 5 * 60 * 1000; // 5 minutes
    private stop$ = new Subject<void>();
    private sessionRevokedSubject = new Subject<void>();
    sessionRevoked$ = this.sessionRevokedSubject.asObservable();

    constructor(private http: HttpClient) {
        // Listen for network changes
        this.window.addEventListener('offline', () => this.pause('offline'));
        this.window.addEventListener('online', () => this.resume('online'));
        // A hidden tab keeps its 60s heartbeat POST alive forever — browsers throttle
        // background timers, they do not stop them. Reuse the existing pause/resume
        // path rather than adding a second mechanism.
        this.window.document?.addEventListener('visibilitychange', () => {
            if (this.window.document?.hidden) this.pause('hidden');
            else this.resume('visible');
        });
    }

    start(token?: string, intervalMs: number = 60000) {
        this.stop();
        this.isPaused = false;

        // Inactivity logic using RxJS
        this.inactivitySub = this.createActivityStream().pipe(
            tap(() => {
                if (this.isPaused) this.resume('activity');
            }),
            startWith(null),
            switchMap(() =>
                timer(this.inactivityMs).pipe(
                    tap(() => this.pause('inactivity'))
                )
            ),
            takeUntil(this.stop$)
        ).subscribe();

        const headers = this.buildHeaders(token);

        // Heartbeat interval
        // `timer(0, …)` rather than `interval(…)`: the first beat fires immediately so a
        // consented visitor with no id yet is minted now, not up to a minute later.
        this.intervalSub = timer(0, intervalMs).pipe(
            filter(() => !this.isPaused && navigator.onLine),
            takeUntil(this.stop$),
            switchMap(() => {
                // Heartbeat requires either a user or guest identifier from cookies/session context.
                // During device-verification gated sign-in, auth can be true before IDs are established.
                // A consented anonymous visitor is the exception: they have no id *yet*, and this
                // first POST is what makes the server mint one (`gid`), after which the id branch
                // above takes over. Without it the tracker is never asked, so the count stays zero.
                if (!this.hasTrackingIdentity() && !this.hasAnalyticsConsent()) {
                    return of({ success: false, skipped: true, reason: 'missing-id' });
                }

                return this.http.post('/event/heartbeat', {}, { headers }).pipe(
                    catchError((error) => this.handleHeartbeatError(error))
                );
            }),
        ).subscribe({
            error(err) {
                console.error('Heartbeat error:', err);
            },
        });
    }

    private createActivityStream(): Observable<Event | null> {
        return merge(
            fromEvent(this.window, 'mousemove', { passive: true }),
            fromEvent(this.window, 'keydown'),
            fromEvent(this.window, 'touchstart', { passive: true })
        ).pipe(startWith(null));
    }

    private buildHeaders(token?: string): HttpHeaders {
        return new HttpHeaders({
            'Authorization': `Bearer ${token || ''}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        });
    }

    private hasTrackingIdentity(): boolean {
        const state = this.guestTrackingService?.getSessionContext();
        return Boolean(state?.userId || state?.guestId);
    }

    /**
     * Whether the visitor granted analytics consent (`consent=granted`, set by
     * `CookieConsentComponent`).
     *
     * The heartbeat is the ONLY same-origin call an anonymous visitor makes that
     * reaches `guestTracker`, and page views cannot reach it at all — Hosting serves
     * the prerendered HTML as a static file before any rewrite applies. Without this
     * branch an anonymous visitor has neither a user nor a guest id, so no request is
     * ever sent, so the tracker is never given the chance to mint the `gid` that would
     * give them an identity: the count stays at zero for every visitor.
     */
    private hasAnalyticsConsent(): boolean {
        try {
            return this.cookieService.get('consent') === 'granted';
        } catch {
            return false;
        }
    }

    private handleHeartbeatError(error: any) {
        // ponytail: the server reports every session gate as a `session_*` code
        // (revoked / signed_out / mismatch). The local session is dead in all three
        // cases, so one prefix check is enough here — see the interceptor for the set.
        const code = String(error?.error?.code || '')
        if (error?.status === 401 && code.startsWith('session_')) {
            this.sessionRevokedSubject.next();
            return throwError(() => error);
        }

        // Guest/user identifiers can be temporarily unavailable during gated sign-in flows
        // (e.g., device verification required). Treat this as a no-op rather than a hard error.
        if (error?.status === 400 && error?.error?.message === 'No guest or user ID found') {
            return of({ success: false, skipped: true, reason: 'missing-id' });
        }

        return throwError(() => error);
    }

    stop() {
        this.stop$.next();
        if (this.intervalSub) {
            this.intervalSub.unsubscribe();
            this.intervalSub = null;
        }
        if (this.inactivitySub) {
            this.inactivitySub.unsubscribe();
            this.inactivitySub = null;
        }
        this.isPaused = true;
    }

    private pause(reason: 'offline' | 'inactivity' | 'hidden') {
        this.isPaused = true;
        // Optionally: notify app of pause reason
        // console.log(`Heartbeat paused due to ${reason}`);
    }

    private resume(reason: 'online' | 'activity' | 'visible') {
        if (!this.isPaused) return;
        this.isPaused = false;
        // Optionally: notify app of resume reason
        // console.log(`Heartbeat resumed due to ${reason}`);
    }
}
