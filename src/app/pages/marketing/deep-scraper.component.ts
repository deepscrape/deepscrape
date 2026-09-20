import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AppFooterComponent } from '../../layout/footer';
import { LandingSubheaderComponent } from '../../shared/landing-subheader/landing-subheader.component';

/**
 * Public marketing page for the "deep scraper" query cluster
 * (deep scraper / deep scrape / deep scraping / deepscraper).
 *
 * Static content on purpose: it is prerendered (`**` → RenderMode.Prerender) and
 * indexed, so it must render without auth or Firestore. Add the route in
 * `routes/main.route.ts` and the matching entry in `seo-title.strategy.ts` — a page
 * missing from the SEO map ships as `noindex`.
 */
@Component({
  selector: 'app-deep-scraper',
  imports: [RouterLink, AppFooterComponent, LandingSubheaderComponent],
  templateUrl: './deep-scraper.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeepScraperComponent {}
