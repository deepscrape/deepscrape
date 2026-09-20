import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AppFooterComponent } from '../../layout/footer';
import { LandingSubheaderComponent } from '../../shared/landing-subheader/landing-subheader.component';

/**
 * Public comparison page for the competitor cluster (crawl4ai alternative,
 * crawl4ai vs). Same contract as the other marketing pages: static, prerendered,
 * must appear in `seo-title.strategy.ts` or it ships as `noindex`.
 */
@Component({
  selector: 'app-crawl4ai-alternative',
  imports: [RouterLink, AppFooterComponent, LandingSubheaderComponent],
  templateUrl: './crawl4ai-alternative.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Crawl4aiAlternativeComponent {}
