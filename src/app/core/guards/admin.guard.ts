import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { take } from 'rxjs/internal/operators/take';
import { map } from 'rxjs/internal/operators/map';
import { AuthzService } from '../services';

export const adminGuard: CanActivateFn = () => {
    const router = inject(Router);
    const authzService = inject(AuthzService);
    return authzService.hasPlatformAdminAccess$().pipe(
        take(1),
        map((isAdmin): boolean | UrlTree => (isAdmin ? true : router.createUrlTree(['/']))),
    );
};
