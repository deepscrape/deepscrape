import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { HttpClient } from '@angular/common/http';
import { PLATFORM_ID } from '@angular/core';

import { AnalyticsService } from './analytics.service';
import { FirestoreService } from './firestore.service';

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let httpMock: HttpTestingController;
  let fireServiceMock: jasmine.SpyObj<FirestoreService>;

  beforeEach(() => {
    fireServiceMock = jasmine.createSpyObj('FirestoreService', ['logEvent']);

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        { provide: FirestoreService, useValue: fireServiceMock },
      ],
    });

    service = new AnalyticsService(
      TestBed.inject(PLATFORM_ID),
      TestBed.inject(HttpClient),
      TestBed.inject(FirestoreService),
    );
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should call backend status endpoint', () => {
    service.sendStatus().subscribe((result) => {
      expect(result).toEqual({ ok: true });
    });

    const req = httpMock.expectOne('/status');
    expect(req.request.method).toBe('GET');
    req.flush({ ok: true });
  });

  it('should log event and queue the payload for the next batch flush', () => {
    service.trackEvent('crawl_started', { source: 'ui' }, 'token-1', 'user-1', 'guest-1').subscribe();

    expect(fireServiceMock.logEvent).toHaveBeenCalledWith('crawl_started', { source: 'ui' });
    // The one-POST-per-event contract is gone: trackEvent queues, and the tab-close
    // flush (the loss-window guard) drains the queue via the existing batch endpoint.
    httpMock.expectNone('/event/analytics/event');

    document.dispatchEvent(new Event('pagehide'));

    const req = httpMock.expectOne('/event/analytics/batch');
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('Authorization')).toBe('Bearer token-1');
    expect(req.request.body).toEqual({
      events: [
        {
          eventType: 'crawl_started',
          metadata: { source: 'ui' },
          userId: 'user-1',
          guestId: 'guest-1',
        },
      ],
    });
    req.flush({ ok: true });
  });

  it('should send batched analytics events', () => {
    const events = [{ eventType: 'a' }, { eventType: 'b' }];
    service.batchTrackEvents(events).subscribe();

    const req = httpMock.expectOne('/event/analytics/batch');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ events });
    req.flush({ ok: true });
  });
});
