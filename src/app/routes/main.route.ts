import { Routes } from '@angular/router';
import { LoginGuard } from '../core/guards';

export const MainRoutes: Routes = [

    {
        path: '', data: { title: 'Home', animation: 'home' }, pathMatch: 'full',
        loadComponent: () => import('../pages').then(m => m.HomeComponent),
    },
    {
        path: 'contact',
        loadComponent: () => import('../pages').then(m => m.ContactComponent),
        data: { title: 'contact', animation: 'contact' },
    },
    {
        path: 'privacy',
        loadComponent: () => import('../pages').then(m => m.PrivacyComponent),
    },
    {
        path: 'terms',
        loadComponent: () => import('../pages').then(m => m.TermsComponent),
    },
    // Public marketing pages. No guard, no `data.title` (seo-title.strategy.ts owns
    // the title/description) and no `animation`, which only layout routes declare.
    {
        path: 'deep-scraper',
        loadComponent: () => import('../pages').then(m => m.DeepScraperComponent),
    },
    {
        path: 'alternatives/crawl4ai',
        loadComponent: () => import('../pages').then(m => m.Crawl4aiAlternativeComponent),
    },
]