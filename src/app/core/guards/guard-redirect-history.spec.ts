import { PlatformLocation } from '@angular/common';
import { Component } from '@angular/core';
import { CanActivateFn, Router, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';

/**
 * Does a guard's `UrlTree` redirect REPLACE the history entry, or push a second one?
 *
 * This decides whether the remaining bare link sites are cosmetic or a bug. If it pushes, then
 * clicking a bare link leaves the bare URL one step back and pressing Back redirects forward
 * again — a trapped Back button — and every bare site must be canonicalised. If it replaces, the
 * sites only cost a no-op hop and can be left alone.
 *
 * Detected by watching `PlatformLocation`: Angular writes history through exactly one of
 * `pushState`/`replaceState`, so counting them is a direct read of what the browser recorded.
 */
@Component({ selector: 'app-blank', standalone: true, template: '' })
class BlankComponent {}

describe('guard UrlTree redirect', () => {
    const redirect: CanActivateFn = () => TestBed.inject(Router).createUrlTree(['acme', 'dashboard']);

    beforeEach(() => {
        TestBed.configureTestingModule({
            imports: [BlankComponent],
            providers: [
                provideRouter([
                    { path: 'dashboard', canActivate: [redirect], component: BlankComponent },
                    { path: 'acme/dashboard', component: BlankComponent },
                ]),
            ],
        });
    });

    it('records one history entry, so Back is not trapped', async () => {
        const router = TestBed.inject(Router);
        const location = TestBed.inject(PlatformLocation);
        const push = spyOn(location, 'pushState').and.callThrough();

        await router.navigateByUrl('/dashboard');

        expect(router.url).toBe('/acme/dashboard');
        // Exactly ONE entry for the redirect as a whole, and no replaceState: Angular resolves the
        // UrlTree before committing history, so the bare URL never ends up behind the user.
        // Measured, not assumed — this is what makes the remaining bare link sites cosmetic.
        expect(push).toHaveBeenCalledTimes(1);
    });
});
