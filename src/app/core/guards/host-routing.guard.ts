import { EnvironmentProviders, inject, makeEnvironmentProviders, PLATFORM_ID, provideAppInitializer } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { NavigationStart, Router } from '@angular/router';
import { filter } from 'rxjs/internal/operators/filter';

import { redirectTargetFor } from './host-routing.policy';

/**
 * Keeps client-side navigations on the origin that owns the target route.
 *
 * Without this, a `routerLink` from a marketing page into an app route renders
 * that app page on the marketing origin — the split's edge redirects never see
 * the navigation, because the router issues no HTTP request. Registering the
 * check against `NavigationStart` covers every entry point at once: template
 * links, `Router.navigate`, the session-revocation interceptor, manual URL
 * entry, and browser back/forward. There is no per-link work to forget.
 *
 * The policy itself is in `host-routing.policy.ts` and is mirrored by the
 * Hosting `redirects`, which remain necessary for cold document loads where no
 * JavaScript has run yet (a bookmarked URL, a `target="_blank"` link, crawlers).
 *
 * SSR is a no-op: the server has no destination origin to redirect to, and app
 * routes are served per-request rather than prerendered.
 *
 * @returns Providers adding the host-routing check.
 */
export function provideHostRouting(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideAppInitializer(() => {
      if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
      const router = inject(Router);
      router.events
        .pipe(filter((event): event is NavigationStart => event instanceof NavigationStart))
        .subscribe((event) => {
          const target = redirectTargetFor(event.url, window.location.hostname);
          // A full document load: cross-origin is unavoidable, and the browser
          // abandons the in-flight router navigation as it unloads.
          if (target) window.location.assign(target);
        });
    }),
  ]);
}
