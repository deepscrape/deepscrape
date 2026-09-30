import { crawlOutcome, crawlOperationStatusColor } from './crawl.fun';
import { CrawlOperationStatus } from '../enum';

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

describe('crawl.fun', () => {
  describe('crawlOperationStatusColor', () => {
    it('should return cyan for IN_PROGRESS status', () => {
      const color = crawlOperationStatusColor(CrawlOperationStatus.IN_PROGRESS);
      expect(color).toBe('cyan');
    });

    it('should return red for FAILED status', () => {
      const color = crawlOperationStatusColor(CrawlOperationStatus.FAILED);
      expect(color).toBe('red');
    });

    it('should return deep-orange for CANCELED status', () => {
      const color = crawlOperationStatusColor(CrawlOperationStatus.CANCELED);
      expect(color).toBe('deep-orange');
    });

    it('should return emerald for SCHEDULED status', () => {
      const color = crawlOperationStatusColor(CrawlOperationStatus.SCHEDULED);
      expect(color).toBe('emerald');
    });

    it('should return green for COMPLETED status', () => {
      const color = crawlOperationStatusColor(CrawlOperationStatus.COMPLETED);
      expect(color).toBe('green');
    });

    it('should return blue for STARTED status', () => {
      const color = crawlOperationStatusColor(CrawlOperationStatus.STARTED);
      expect(color).toBe('blue');
    });

    it('should return gray for READY status', () => {
      const color = crawlOperationStatusColor(CrawlOperationStatus.READY);
      expect(color).toBe('gray');
    });

    it('should return gray as default for unknown status', () => {
      const color = crawlOperationStatusColor('UNKNOWN' as any);
      expect(color).toBe('gray');
    });

    it('should always return a valid color string', () => {
      const validColors = [
        'cyan',
        'red',
        'deep-orange',
        'emerald',
        'green',
        'blue',
        'gray',
      ];

      for (const status of Object.values(CrawlOperationStatus)) {
        const color = crawlOperationStatusColor(status);
        expect(validColors).toContain(color);
      }
    });
  });
});
