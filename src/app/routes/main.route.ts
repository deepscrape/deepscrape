import { Routes } from '@angular/router';
import { LoginGuard } from '../core/guards';

export const MainRoutes: Routes = [

    {
        path: '', data: { title: 'Home', animation: 'home' }, pathMatch: 'full',
        // Direct page import, not the '../pages' barrel. Every route importing the barrel
        // produced ONE chunk containing all pages; because the landing page comes from that
        // same barrel its chunk was initial (modulepreloaded by index.html), which pulled
        // chart.js, Stripe, Firestore and Material into the landing payload.
        loadComponent: () => import('../pages/home/home.component').then(m => m.HomeComponent),
    },
    {
        path: 'contact',
        loadComponent: () => import('../pages/service/contact/contact.component').then(m => m.ContactComponent),
        data: { title: 'contact', animation: 'contact' },
    },
    {
        path: 'privacy',
        loadComponent: () => import('../pages/legal/privacy.component').then(m => m.PrivacyComponent),
    },
    {
        path: 'terms',
        loadComponent: () => import('../pages/legal/terms.component').then(m => m.TermsComponent),
    },
    // Public marketing pages. No guard, no `data.title` (seo-title.strategy.ts owns
    // the title/description) and no `animation`, which only layout routes declare.
    {
        path: 'deep-scraper',
        loadComponent: () => import('../pages/marketing/deep-scraper.component').then(m => m.DeepScraperComponent),
    },
    {
        path: 'alternatives/crawl4ai',
        loadComponent: () => import('../pages/marketing/crawl4ai-alternative.component').then(m => m.Crawl4aiAlternativeComponent),
    },
    {
        path: 'mcp-web-scraping',
        loadComponent: () => import('../pages/marketing/mcp-web-scraping.component').then(m => m.McpWebScrapingComponent),
    },
]