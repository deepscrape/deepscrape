import { ChangeDetectionStrategy, Component, Input, Output, EventEmitter, HostBinding, signal, WritableSignal, ViewChildren, QueryList } from '@angular/core';
import { CommonModule, JsonPipe, NgClass } from '@angular/common';
import { CrawlResults } from '../../types';
import { crawlOutcome, CrawlOutcome, CrawlOutcomeInput } from '../../functions';
import { expandCollapseAnimation } from 'src/app/animations';
import { MarkdownModule } from 'ngx-markdown';
import { MatIconModule } from '@angular/material/icon'; // Import MatIconModule
import { LucideAngularModule } from 'lucide-angular';
import { myIcons } from 'src/app/shared/lucideicons';
import { PdfSrcPipe } from '../../pipes';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-crawl-result-item',
  imports: [CommonModule, NgClass, JsonPipe, MarkdownModule, MatIconModule, LucideAngularModule, PdfSrcPipe, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [expandCollapseAnimation],
  templateUrl: './crawl-result-item.component.html',
  styles: [`
    /* Custom styles for tab overflow if needed, or rely on JS for dynamic class application */
    /* Example: Hide scrollbar for tab container if it overflows */
    .flex-wrap::-webkit-scrollbar {
      display: none;
    }
    .flex-wrap {
      -ms-overflow-style: none;  /* IE and Edge */
      scrollbar-width: none;  /* Firefox */
    }
  `]
})
export class CrawlResultItemComponent {
  @Input() crawlResult!: CrawlResults;
  @Input() clipboardButton: any; // Type as any for now, as it's a component reference
  @Output() toggleExpand = new EventEmitter<CrawlResults>();

  readonly icons = myIcons
  activeSubTab: string = 'overview';

  /**
   * What this result actually IS, as opposed to what it contains.
   *
   * `crawlOutcome()` runs the rule rather than this component, so the
   * discriminator keeps one home and a new gate value from the worker degrades to
   * "blocked" instead of to "ok". It reads the result structurally, which is what
   * lets it survive this repo declaring `CrawlResult` three times.
   */
  get outcome(): CrawlOutcome {
    return crawlOutcome(this.crawlResult as unknown as CrawlOutcomeInput);
  }

  /**
   * A gate is not a scrape.
   *
   * When this is true the template withholds every content pane. A Cloudflare
   * interstitial is valid HTML with a real title and real markdown, so rendering
   * it as a result would present a block page as extracted content — the exact
   * failure this state exists to prevent.
   */
  get isGated(): boolean {
    return this.outcome === 'challenge';
  }

  /** Notice heading for a gate. Unknown kinds get the generic copy. */
  get gateTitleKey(): string {
    switch ((this.crawlResult as unknown as CrawlOutcomeInput).challenge) {
      case 'blocked':
        return 'CR_RES.OUTCOME_CHALLENGE_BLOCKED_TITLE';
      case 'captcha':
        return 'CR_RES.OUTCOME_CHALLENGE_CAPTCHA_TITLE';
      default:
        return 'CR_RES.OUTCOME_CHALLENGE_TITLE';
    }
  }

  subTabs = [
    { key: 'overview', label: 'CR_RES.TAB_OVERVIEW' },
    { key: 'metadata', label: 'CR_RES.TAB_METADATA' },
    { key: 'media', label: 'CR_RES.TAB_MEDIA' },
    { key: 'links', label: 'CR_RES.TAB_LINKS' },
    { key: 'tables', label: 'CR_RES.TAB_TABLES' },
    { key: 'raw_markdown', label: 'CR_RES.TAB_MARKDOWN' },
    { key: 'raw_html', label: 'CR_RES.TAB_HTML' },
    { key: 'technical_details', label: 'CR_RES.TAB_TECH' },
    { key: 'files', label: 'CR_RES.TAB_FILES' },
  ];

  selectSubTab(tabName: string): void {
    this.activeSubTab = tabName;
  }

  getOverviewData(): any {
    const { url, status, message, success, status_code, error_message, session_id, redirected_url } = this.crawlResult;
    return { url, status, message, success, status_code, error_message, session_id, redirected_url };
  }

  getTechnicalDetails(): any {
    const { response_headers, network_requests, console_messages, ssl_certificate, dispatch_result, js_execution_result, server_memory_mb } = this.crawlResult;
    return { response_headers, network_requests, console_messages, ssl_certificate, dispatch_result, js_execution_result, server_memory_mb };
  }

  getFullImageUrl(imageSrc: string, fullUrl: string): string {
    const pattern = /^(https?:\/\/|www\.|ftp:\/\/)/;

    try {
      if (pattern.test(imageSrc)) {
        return imageSrc; // Return the full URL as is
      } else {
        const url = new URL(fullUrl); // Create a URL object, Get the host domain
        // Return the host (including protocol)
        return `${url.origin}/${imageSrc}`; // Concatenate the domain with the image source
      }
      

    } catch (error) {
      console.error('Invalid full URL:', error);
      return imageSrc; // Return an empty string if the URL is invalid
    }

    
  }
}
