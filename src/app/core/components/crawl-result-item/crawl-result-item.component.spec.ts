import { CrawlResultItemComponent } from './crawl-result-item.component';
import type { CrawlResults } from '../../types';

/**
 * A gated crawl must not look like a scrape that merely came back empty.
 *
 * `core/functions/crawl.fun.spec.ts` already pins the classifier. This pins the
 * component's own decisions on top of it — `isGated`, which withholds every
 * content pane, and `gateTitleKey`, which names the gate — because those are what
 * a user actually sees. A change that kept the classifier correct but stopped
 * withholding content would satisfy that spec and fail this one, which is the
 * regression worth catching: a Cloudflare interstitial is valid HTML with a real
 * title and real markdown, so rendering it presents a block page as a result.
 *
 * No `TestBed`: the component has no constructor dependencies, so instantiating the
 * real class is both cheaper and more faithful than a shallow fixture.
 */
describe('CrawlResultItemComponent - outcome state', () => {
  const make = (result: Partial<CrawlResults>): CrawlResultItemComponent => {
    const component = new CrawlResultItemComponent();
    component.crawlResult = result as CrawlResults;
    return component;
  };

  /** `CrawlResults.markdown` is an object, not a string — the real shape. */
  const body = (raw: string) => ({
    raw_markdown: raw,
    markdown_with_citations: '',
    references_markdown: '',
    fit_markdown: '',
    fit_html: '',
  });

  it('calls a challenge a gate, even when the gate page looks like content', () => {
    const component = make({
      challenge: 'cloudflare_challenge',
      success: true,
      status_code: 200,
      markdown: body('# Just a moment...'),
    });

    expect(component.outcome).toBe('challenge');
    expect(component.isGated).toBe(true);
  });

  it('does not call an empty body a gate', () => {
    const component = make({ success: true, markdown: body('') });

    expect(component.outcome).toBe('empty');
    expect(component.isGated).toBe(false);
  });

  it('separates a hard failure from both', () => {
    const component = make({ success: false, status_code: 403 });

    expect(component.outcome).toBe('failed');
    expect(component.isGated).toBe(false);
  });

  it('leaves a normal result as ok', () => {
    const component = make({ success: true, status_code: 200, markdown: body('# Real page') });

    expect(component.outcome).toBe('ok');
    expect(component.isGated).toBe(false);
  });

  it('names the gate kind, and degrades an unknown kind to the generic notice', () => {
    expect(make({ challenge: 'blocked' }).gateTitleKey).toBe('CR_RES.OUTCOME_CHALLENGE_BLOCKED_TITLE');
    expect(make({ challenge: 'captcha' }).gateTitleKey).toBe('CR_RES.OUTCOME_CHALLENGE_CAPTCHA_TITLE');
    expect(make({ challenge: 'cloudflare_challenge' }).gateTitleKey).toBe('CR_RES.OUTCOME_CHALLENGE_TITLE');
    expect(make({ challenge: 'some_new_gate' }).gateTitleKey).toBe('CR_RES.OUTCOME_CHALLENGE_TITLE');
  });
});
