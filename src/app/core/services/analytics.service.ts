import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { FirestoreService } from './firestore.service';
import { catchError } from 'rxjs/operators';
import { of, throwError, Observable } from 'rxjs';
import { isPlatformBrowser } from '@angular/common';
// Shared with the server's batch handler: it rejects anything larger with a 413.
import { CLIENT_EVENT_LIST_MAX } from '../../../config/redis-keys';
// Shared with the Functions drain, which counts anything off this list as `unknown`.
import { ClientAnalyticsEvent } from '../../../config/analytics-events';


@Injectable({
  providedIn: 'root'
})
export class AnalyticsService {
  private analyticsBackendAvailable = true;

  /**
   * `trackEvent` used to POST once per event even though `/event/analytics/batch`
   * already existed next door, so a click burst became a request burst. Queue here
   * and let the existing batch endpoint do the talking.
   * ponytail: single 3s timer, no size cap. Add a cap if a burst can exceed the
   * backend's body limit; the unload flush below covers the loss window.
   */
  private eventQueue: any[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private lastToken?: string
  private unloadFlushAttached = false
  private static readonly FLUSH_MS = 3000

  private enqueueEvent(event: any, token?: string): void {
    this.eventQueue.push(event)
    if (token) this.lastToken = token
    this.attachUnloadFlush()
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushEvents(), AnalyticsService.FLUSH_MS)
    }
  }

  private flushEvents(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.eventQueue.length) return

    // Chunk at the server's cap: it answers 413 and drops the WHOLE batch, so an
    // over-large flush would lose every queued event at once.
    while (this.eventQueue.length) {
      const events = this.eventQueue.splice(0, CLIENT_EVENT_LIST_MAX)
      this.batchTrackEvents(events, this.lastToken).subscribe({ error: () => undefined })
    }
  }

  /** Telemetry must survive a tab close, or the last flush window is silently lost. */
  private attachUnloadFlush(): void {
    if (this.unloadFlushAttached || !isPlatformBrowser(this.platformId)) return
    this.unloadFlushAttached = true
    document.addEventListener('pagehide', () => this.flushEvents())
  }

  constructor(
    @Inject(PLATFORM_ID) private platformId: Object,
    private http: HttpClient,
    private fireService: FirestoreService,
  ) { }

  sendStatus() {
    if (!isPlatformBrowser(this.platformId)) {
      return of(null)
    }

    if (!this.analyticsBackendAvailable) {
      return of(null)
    }

    return this.http.get(`/status`).pipe(
      catchError((error) => this.handleError(error))
    )
  }
  
  /**
   * Send analytics event to Google Analytics and backend for aggregation
   *
   * The name is typed against the shared allow-list, so a typo is a compile error
   * instead of a permanent `clientEvents.<typo>` counter key nothing reads. Add the
   * name to `src/config/analytics-events.ts` first, then emit it.
   */
  trackEvent(eventType: ClientAnalyticsEvent, metadata: any = {}, token?: string, userId?: string, guestId?: string) {
    if (!isPlatformBrowser(this.platformId)) {
      return of(null)
    }

    if (!this.analyticsBackendAvailable) {
      this.fireService.logEvent(eventType, metadata)
      return of(null)
    }

    // Google Analytics logEvent
    this.fireService.logEvent(eventType, metadata)
    // Queue for the next flush instead of one POST per event.
    this.enqueueEvent({ eventType, metadata, userId, guestId }, token)
    return of(null);
  }

  /**
   * Batch send analytics events to backend (for debounced/batched writes)
   */
  batchTrackEvents(events: any[], token?: string) {
    if (!isPlatformBrowser(this.platformId)) {
      return of(null)
    }

    if (!this.analyticsBackendAvailable) {
      events.forEach(ev => {
        this.fireService.logEvent(ev.method || ev.eventType || ev.event, ev.metadata ?? ev.properties)
      });
      return of(null)
    }

    // Optionally batch logEvent to Google Analytics (not supported natively, so log individually)
    events.forEach(ev => {
      this.fireService.logEvent(ev.method || ev.eventType || ev.event, ev.metadata ?? ev.properties)
    });
    // Send batch to backend. HttpHeaders is immutable: append() returns a new
    // instance, so the old code silently dropped the Authorization header.
    let headers = new HttpHeaders({ 'Accept': 'application/json' });
    if (token) headers = headers.set('Authorization', `Bearer ${token}`);
    return this.http.post('/event/analytics/batch', { events }, { headers }).pipe(
      catchError((error) => this.handleError(error)))
  }

  private handleError(error: any): Observable<any> {
    if (error?.status === 404) {
      const backendMessage = typeof error?.error === 'string' ? error.error : ''
      const missingFunction = backendMessage.includes('does not exist')

      if (missingFunction) {
        this.analyticsBackendAvailable = false
        console.warn('Analytics backend disabled for this session (missing function route):', error)
        return of(null)
      }

      console.warn('Analytics backend endpoint not found:', error)
      return of(null)
    }

    if (error?.status >= 500) {
      console.warn('Analytics backend unavailable (non-fatal):', error)
      return of(null)
    }

    console.error('Analytics backend error:', error)
    return of(null)
  }
}

