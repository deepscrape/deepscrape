import { Routes } from '@angular/router';
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
        loadComponent: () => import('../../pages/user/settings/profile/profile.component').then(m => m.ProfileTabComponent),
        data: { title: 'Profile', animation: 'profile' },
        resolve: { user: UserResolver },
    },
    {
        path: 'general',
        loadComponent: () => import('../../pages/user/settings/general/general.component').then(m => m.GeneralTabComponent),
        data: { title: 'General', animation: 'general' },
    },
    {
        path: 'security',
        loadComponent: () => import('../../pages/user/settings/security/security.component').then(m => m.SecurityTabComponent),
        data: { title: 'Security', animation: 'security' },
        resolve: { user: UserResolver },
    },
    {
        path: 'keys',
        loadComponent: () => import('../../pages/user/settings/api-keys/api-keys.component').then(m => m.ApiKeysComponent),
        data: { title: 'API Keys', animation: 'apikeys' },
    },
    {
        path: 'workspace',
        loadComponent: () => import('../../pages/user/settings/workspace/workspace.component').then(m => m.WorkspaceTabComponent),
        canActivate: [authzGuard],
        data: {
            title: 'Workspace',
            animation: 'workspace',
            authz: { resource: 'organization', action: 'read' },
        },
    },
    {
        path: 'storage',
        loadComponent: () => import('../../pages/user/settings/storage/storage.component').then(m => m.StorageTabComponent),
        data: { title: 'Storage', animation: 'storage' },
    },
]
