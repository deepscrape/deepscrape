import { DestroyRef, Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { isPlatformBrowser } from '@angular/common';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs/internal/operators/filter';

// Dynamic import keeps the Performance SDK out of the initial bundle: the first trace
// is recorded after first paint, so nothing needs it at bootstrap.
type PerfModule = typeof import('firebase/performance');

/**
 * Firebase Performance Monitoring for real-user latency.
 *
 * Wraps the raw SDK rather than the AngularFire `traceUntil*` helpers so the same
 * handle can attach attributes *before* the work finishes and record extra metrics
 * at the end — the useful case (e.g. "crawl finished, N urls, M bytes").
 *
 * Two things are instrumented out of the box:
 * - `app_bootstrap`: first navigation end minus `performance.timeOrigin`, i.e. what
 *   the user actually waited for including SSR HTML + hydration.
 * - `route_navigation`: every subsequent client-side navigation, with the target URL.
 *
 * Nothing here runs during SSR: `trace()` touches window and would throw.
 */

@Injectable({ providedIn: 'root' })
export class PerformanceService {
  private readonly platformId = inject(PLATFORM_ID);
  private perfModule: Promise<PerfModule | null> | null = null;
  private readonly destroyed = inject(DestroyRef);
  private readonly router = inject(Router);

  private readonly enabledState = signal(false);
  private readonly bootstrappedState = signal(false);

  /** False during SSR or when the browser blocks performance collection. */
  readonly enabled = this.enabledState.asReadonly();
  /** True once the initial navigation has been recorded. */
  readonly bootstrapped = this.bootstrappedState.asReadonly();

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return;
    this.enabledState.set(true);
    this.instrumentNavigations();
  }

  /**
   * Wrap an async unit of work in a trace. The trace stops on both paths, and
   * failures are rethrown so callers keep their own error handling.
   *
   * @param {string} name Trace name.
   * @param {() => Promise<T>} work The operation to measure.
   * @param {Record<string, string>} attributes Optional attributes.
   * @return {Promise<T>} Whatever `work` resolves to.
   */
  async measure<T>(
    name: string,
    work: () => Promise<T>,
    attributes?: Record<string, string>,
  ): Promise<T> {
    const perf = await this.loadPerf();
    if (!perf) return work();

    let stop: (() => void) | null = null;
    try {
      const active = perf.trace(perf.getPerformance(), name);
      active.start();
      for (const [key, value] of Object.entries(attributes || {})) {
        active.putAttribute(key, value);
      }
      stop = () => active.stop();
    } catch {
      // Tracing must never break the work it wraps.
    }

    try {
      return await work();
    } finally {
      stop?.();
    }
  }

  /**
   * Record an already-measured duration (custom timing you timed yourself).
   *
   * @param {string} name Trace name.
   * @param {number} durationMs Duration in milliseconds.
   * @param {Record<string, string>} attributes Optional attributes.
   */
  record(name: string, durationMs: number, attributes?: Record<string, string>): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;

    void this.loadPerf()
      .then((perf) => {
        if (!perf) return;
        try {
          const endedAt = Date.now();
          // 2-arg `trace(perf, name)`: this Firebase version has no options overload.
          // Attributes go on via putAttribute below.
          const active = perf.trace(perf.getPerformance(), name);
          for (const [key, value] of Object.entries(attributes || {})) {
            active.putAttribute(key, value);
          }
          // `record` takes an absolute start time, so a trace created after the fact
          // still reports the true duration rather than the time since start().
          active.record(endedAt - durationMs, durationMs);
        } catch {
          // Tracing must never break the caller's flow.
        }
      })
      .catch(() => undefined);
  }

  private instrumentNavigations(): void {
    const origin = performance.timeOrigin;
    let firstNavigationSeen = false;

    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyed),
      )
      .subscribe((event) => {
        if (!firstNavigationSeen) {
          firstNavigationSeen = true;
          this.bootstrappedState.set(true);
          // Cold-start cost: origin is when the document request began, so this
          // includes network + SSR HTML + hydration, not just Angular bootstrap.
          this.record('app_bootstrap', Date.now() - origin, { path: event.urlAfterRedirects });
          return;
        }
        this.record('route_navigation', 0, { url: event.urlAfterRedirects });
      });
  }

  /** Cached dynamic import, resolved once. Null when tracing is unavailable. */
  private loadPerf(): Promise<PerfModule | null> {
    this.perfModule ||= import('firebase/performance').catch(() => null);
    return this.perfModule;
  }
}
