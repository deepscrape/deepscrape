import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AppFooterComponent } from '../../layout/footer';
import { LandingSubheaderComponent } from '../../shared/landing-subheader/landing-subheader.component';

/**
 * Public marketing page for the MCP web scraping cluster
 * (mcp web scraping / mcp scraping server / mcp scraper / browser automation for ai agents).
 *
 * Static content on purpose: it is prerendered (`**` → RenderMode.Prerender) and
 * indexed, so it must render without auth or Firestore. Contract for every
 * marketing page in this folder — add the route in `routes/main.route.ts`, an entry
 * in `seo-title.strategy.ts` (missing from the SEO map means it ships `noindex`) and
 * the URL in `public/sitemap.xml`.
 *
 * Content is English-only by design, matching the legal and other marketing pages:
 * the prose is the source of truth here, so it is not duplicated into i18n keys.
 */
@Component({
  selector: 'app-mcp-web-scraping',
  imports: [RouterLink, AppFooterComponent, LandingSubheaderComponent],
  templateUrl: './mcp-web-scraping.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class McpWebScrapingComponent {
  /** External authority targets cited in the body (E-E-A-T), kept out of the template. */
  readonly webrainDocsUrl = 'https://docs.webrayn.dev';
  readonly webrainRepoUrl = 'https://github.com/prokopis3/webrain';
}
