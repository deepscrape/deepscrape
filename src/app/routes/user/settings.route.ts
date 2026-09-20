import { Routes } from '@angular/router';
import { provideNgxStripe } from 'ngx-stripe';
import { UserResolver } from 'src/app/core/services';
import { authzGuard } from 'src/app/core/guards';


export const settingsRoutes: Routes = [
    {
        path: '',
        pathMatch: 'full',
        redirectTo: 'general'
    },
    {
        path: 'profile',
        loadComponent: () => import('../../pages').then(m => m.ProfileTabComponent),
        data: { title: 'Profile', animation: 'profile' },
        resolve: { user: UserResolver },
    },
    {
        path: 'general',
        loadComponent: () => import('../../pages').then(m => m.GeneralTabComponent),
        data: { title: 'General', animation: 'general' },
    },
    {
        path: 'payment',
        loadComponent: () => import('../../pages').then(m => m.PaymentTabComponent),
        providers: [provideNgxStripe()],
        data: { title: 'Payment', animation: 'payment' },
    },
    {
        path: 'security',
        loadComponent: () => import('../../pages').then(m => m.SecurityTabComponent),
        data: { title: 'Security', animation: 'security' },
        resolve: { user: UserResolver },
    },
    {
        path: 'keys',
        loadComponent: () => import('../../pages').then(m => m.ApiKeysComponent),
        data: { title: 'API Keys', animation: 'apikeys' },
    },
    {
        path: 'workspace',
        loadComponent: () => import('../../pages').then(m => m.WorkspaceTabComponent),
        canActivate: [authzGuard],
        data: {
            title: 'Workspace',
            animation: 'workspace',
            authz: { resource: 'organization', action: 'read' },
        },
    },
]
