import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Observable } from 'rxjs/internal/Observable';
import { of } from 'rxjs/internal/observable/of';
import { AuthzService, OrganizationService } from '../services';
import { isMemberOf, orgScopeGuard } from './org-scope.guard';

describe('isMemberOf', () => {
    const organizations = [{ id: 'acme' }, { id: 'globex' }];

    it('accepts an organization the user belongs to', () => {
        expect(isMemberOf(organizations, 'acme')).toBe(true);
    });

    it('rejects an organization the user does not belong to', () => {
        expect(isMemberOf(organizations, 'initech')).toBe(false);
    });

    it('rejects a missing or empty organization id', () => {
        expect(isMemberOf(organizations, null)).toBe(false);
        expect(isMemberOf(organizations, '')).toBe(false);
    });
});

/**
 * These cover the behaviours that otherwise need a signed-in session to check by hand. The
 * "url tree" is a hand-rolled stub so the assertions can read the segments the guard produced —
 * which is the whole point: what the user would land on.
 */
describe('orgScopeGuard', () => {
    let activeOrgId: string | null;
    let organizations: { id: string }[];
    let setActiveOrgId: jasmine.Spy;
    let tree: { root: { children: { primary: { segments: { path: string }[] } } } };

    const segments = () => tree.root.children.primary.segments.map((segment) => segment.path);

    beforeEach(() => {
        activeOrgId = null;
        organizations = [];
        setActiveOrgId = jasmine.createSpy('setActiveOrgId');
        tree = { root: { children: { primary: { segments: [] } } } };

        TestBed.configureTestingModule({
            providers: [
                { provide: OrganizationService, useValue: { listMyOrganizations: () => of({ organizations }) } },
                {
                    provide: AuthzService,
                    useValue: {
                        get activeOrgId() {
                            return activeOrgId;
                        },
                        setActiveOrgId,
                    },
                },
                { provide: Router, useValue: { parseUrl: () => tree, createUrlTree: (commands: unknown[]) => ({ commands }) } },
            ],
        });
    });

    const activate = (requested: string) => {
        tree.root.children.primary.segments = requested
            .split('/')
            .filter(Boolean)
            .map((path) => ({ path }));

        return TestBed.runInInjectionContext(() =>
            orgScopeGuard(
                { paramMap: { get: () => requested } } as never,
                { url: `/${requested}` } as never,
            ),
        );
    };

    it('accepts a url that already names the active org, with no lookup', () => {
        activeOrgId = 'acme';

        expect(activate('acme')).toBe(true);
        expect(setActiveOrgId).not.toHaveBeenCalled();
    });

    it('rewrites a bare /dashboard onto the org ROOT, not /{orgId}/dashboard', () => {
        activeOrgId = 'acme';

        activate('dashboard');

        expect(segments()).toEqual(['acme']);
    });

    it('re-homes any other bare page path under the org', () => {
        activeOrgId = 'acme';

        activate('billing');

        expect(segments()).toEqual(['acme', 'billing']);
    });

    it('never adopts, or navigates into, an org the user is not a member of', (done) => {
        activeOrgId = 'acme';
        organizations = [{ id: 'acme' }];

        (activate('evil') as unknown as Observable<unknown>).subscribe(() => {
            expect(setActiveOrgId).not.toHaveBeenCalled();
            expect(segments()).toEqual(['acme', 'evil']);
            done();
        });
    });

    it('adopts a real org from the url after confirming membership', (done) => {
        activeOrgId = null;
        organizations = [{ id: 'acme' }, { id: 'globex' }];

        (activate('globex') as unknown as Observable<unknown>).subscribe((result) => {
            expect(setActiveOrgId).toHaveBeenCalledWith('globex');
            expect(result).toBe(true);
            done();
        });
    });
});
