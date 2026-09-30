import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';

import { CrawlAPIService } from './crawlapi.service';
import { getTestProviders } from 'src/app/testing';
import { AuthService } from './auth.service';

describe('CrawlAPIService', () => {
  let service: CrawlAPIService;
  let httpMock: HttpTestingController;
  let authServiceMock: jasmine.SpyObj<AuthService>;

  beforeEach(() => {
    authServiceMock = jasmine.createSpyObj('AuthService', [], {
      token: 'token-123',
    });

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [...getTestProviders(), { provide: AuthService, useValue: authServiceMock }],
    });

    service = TestBed.inject(CrawlAPIService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should send cancellation request for task id', () => {
    service.cancelTask('task-2').subscribe((result) => {
      expect(result).toEqual({ canceled: true });
    });

    const req = httpMock.expectOne((request) => request.method === 'PUT' && request.url.endsWith('/task-2/cancel'));
    expect(req.request.headers.get('Authorization')).toBe('Bearer token-123');
    req.flush({ canceled: true });
  });

  it('should map enqueue response into CrawlTask shape', (done) => {
    const operationData = { id: 'op-1' } as any;
    const crawlPack = { config: { value: { markdown: true } } } as any;

    service.multiCrawlEnqueue(['https://example.com'], operationData, crawlPack).subscribe((task) => {
      expect(task.id).toBe('task-10');
      expect(task.operationId).toBe('op-1');
      done();
    });

    const req = httpMock.expectOne((request) => request.method === 'POST' && request.url.endsWith('/crawl/stream/job'));
    expect(req.request.body.urls).toEqual(['https://example.com']);
    req.flush({ task_id: 'task-10', operation_id: 'op-1' });
  });

  // `/api/crawl` is served by whichever provider the platform resolved, so the
  // client has to read both answer shapes. Before this, a bare string was sent and
  // only the crawl4ai shape was read — the request was refused by the shared guard
  // and, had it been accepted, the mapping would have thrown on a missing `data`.
  describe('sendToCrawl4AI provider shapes', () => {
    it('sends the target as a list, which is what the shared guard reads', () => {
      service.sendToCrawl4AI('https://example.com', {} as any).subscribe();

      const req = httpMock.expectOne((request) => request.method === 'POST' && request.url.endsWith('/crawl'));
      expect(req.request.body.urls).toEqual(['https://example.com']);
      req.flush({ provider: 'webrain', status: 'ok', count: 1, failed: 0, results: [] });
    });

    it('reads content out of the webrain result envelope', (done) => {
      service.sendToCrawl4AI('https://example.com', {} as any).subscribe((content) => {
        expect(content).toBe('# Hello');
        done();
      });

      const req = httpMock.expectOne((request) => request.method === 'POST' && request.url.endsWith('/crawl'));
      req.flush({
        provider: 'webrain',
        status: 'ok',
        count: 1,
        failed: 0,
        results: [
          {
            url: 'https://example.com',
            ok: true,
            data: { content: '# Hello' },
            challenge: null,
            tokens: { chars: 8, est_tokens: 2 },
            ms: 12,
          },
        ],
      });
    });

    it('still reads the crawl4ai shape', (done) => {
      service.sendToCrawl4AI('https://example.com', {} as any).subscribe((content) => {
        expect(content).toBe('# Legacy');
        done();
      });

      const req = httpMock.expectOne((request) => request.method === 'POST' && request.url.endsWith('/crawl'));
      req.flush({ code: 200, status: 'ok', data: { url: 'https://example.com', content: '# Legacy' } });
    });

    it('surfaces the provider error rather than resolving with empty content', (done) => {
      service.sendToCrawl4AI('https://example.com', {} as any).subscribe({
        next: () => done.fail('expected the refusal to propagate'),
        error: (error) => {
          expect(error.message).toBe('cloudflare challenge');
          done();
        },
      });

      const req = httpMock.expectOne((request) => request.method === 'POST' && request.url.endsWith('/crawl'));
      req.flush({
        provider: 'webrain',
        status: 'error',
        count: 1,
        failed: 1,
        results: [{ url: 'https://example.com', ok: false, error: 'cloudflare challenge', challenge: 'cloudflare' }],
      });
    });

    it('does not send the same credential under two header names', () => {
      service.sendToCrawl4AI('https://example.com', {} as any).subscribe();

      const req = httpMock.expectOne((request) => request.method === 'POST' && request.url.endsWith('/crawl'));
      expect(req.request.headers.get('Authorization')).toBe('Bearer token-123');
      expect(req.request.headers.has('api-key')).toBe(false);
      req.flush({ provider: 'webrain', status: 'ok', count: 1, failed: 0, results: [] });
    });
  });
});
