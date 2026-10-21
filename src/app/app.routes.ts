import { Routes } from '@angular/router';
import { MainRoutes, ServiceRoutes, UserRoutes } from './routes';

export const routes: Routes = [
    ...MainRoutes,
    ...ServiceRoutes,
    ...UserRoutes,
    { path: '**', loadComponent: () => import('./layout/full/app-not-found/app-not-found.component').then(m => m.NotFoundComponent) },
];
