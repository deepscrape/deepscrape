import { crawlOutcome } from './crawl.fun';

describe('crawl.fun - crawlOutcome', () => {
  const body = { markdown: '# hello' };

  it('reports a Cloudflare interstitial as a challenge, not as content', () => {
    expect(crawlOutcome({ ...body, challenge: 'cloudflare_challenge' })).toBe('challenge');
  });

  it('keeps blocked visibly distinct from empty', () => {
    expect(crawlOutcome({ challenge: 'blocked' })).toBe('challenge');
    expect(crawlOutcome({ success: true })).toBe('empty');
    expect(crawlOutcome({ success: true })).not.toBe('challenge');
  });

  it('lets a gate outrank the body it shipped with', () => {
    // the point of the whole function: a gate page parses as good HTML
    expect(crawlOutcome({ ...body, challenge: 'captcha', success: true, status_code: 200 })).toBe('challenge');
  });

  it('treats an unknown challenge value as a gate rather than as content', () => {
    expect(crawlOutcome({ ...body, challenge: 'some_new_gate' })).toBe('challenge');
  });

  it('reports a real body as ok', () => {
    expect(crawlOutcome({ ...body, success: true, status_code: 200 })).toBe('ok');
  });

  it('reports failure through success, error_message and status_code', () => {
    expect(crawlOutcome({ success: false, ...body })).toBe('failed');
    expect(crawlOutcome({ error_message: 'boom', ...body })).toBe('failed');
    expect(crawlOutcome({ status_code: 403, ...body })).toBe('failed');
  });

  it('treats a missing result as failed', () => {
    expect(crawlOutcome(null)).toBe('failed');
    expect(crawlOutcome(undefined)).toBe('failed');
  });

  it('treats an empty-string body as empty, not ok', () => {
    expect(crawlOutcome({ success: true, markdown: '' })).toBe('empty');
  });

  it('treats an emptied markdown OBJECT as empty, not ok', () => {
    // `CrawlResults.markdown` is an object, so a stripped result arrives as
    // `{raw_markdown: '', ...}`. Comparing that object to '' never matched, so it
    // fell through to `ok` — the false positive this state exists to prevent.
    expect(crawlOutcome({ success: true, markdown: { raw_markdown: '', fit_markdown: '' } })).toBe('empty');
  });

  it('still reads a populated markdown object as ok', () => {
    expect(crawlOutcome({ success: true, markdown: { raw_markdown: '# Real page' } })).toBe('ok');
  });

  it('falls back to html when the markdown object is empty', () => {
    expect(crawlOutcome({ success: true, markdown: { raw_markdown: '' }, cleaned_html: '<p>hi</p>' })).toBe('ok');
  });
});
