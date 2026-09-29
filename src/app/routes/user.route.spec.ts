import { orgScopeGuard } from '../core/guards/org-scope.guard';
import { UserRoutes } from './user.route';

/**
 * The route TABLE's shape is load-bearing, and nothing else pins it: a route-ordering slip does
 * not fail to compile, it silently changes which tree serves a URL.
 */
describe('UserRoutes', () => {
    it('declares the console before :orgId, so /admin is not read as an org id', () => {
        const paths = UserRoutes.map(route => route.path);

        expect(paths).toContain('admin');
        expect(paths.indexOf('admin')).toBeLessThan(paths.indexOf(':orgId'));
    });

    it('keeps the bare tree last, where it acts as the legacy fallback', () => {
        expect(UserRoutes[UserRoutes.length - 1].path).toBe('');
    });

    it('guards the org tree with the org scope guard', () => {
        const orgRoute = UserRoutes.find(route => route.path === ':orgId');

        expect(orgRoute?.canActivate).toContain(orgScopeGuard);
    });
});
