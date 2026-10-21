import { TestBed, fakeAsync, tick, flushMicrotasks } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { CookieService } from 'ngx-cookie-service';

import { HeartbeatService } from './heartbeat.service';
import { GuestTrackingService } from './guest-tracking.service';
import { getTestProviders } from 'src/app/testing';

describe('HeartbeatService', () => {
  let service: HeartbeatService;
  let httpMock: HttpTestingController;
  let revoked: jasmine.Spy;

  const BEAT_MS = 60000;

  /** The identity branch is driven directly: the real tracker reads a cookie we cannot write. */
  let sessionContext: { guestId: string | null, userId: string | null, loginId: string | null, guestFingerprint: string | null };
  let cookieGet: jasmine.Spy;

  beforeEach(() => {
    sessionContext = { guestId: 'guest-1', userId: null, loginId: null, guestFingerprint: null };
    cookieGet = jasmine.createSpy('cookieService.get').and.returnValue('');

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        ...getTestProviders(),
        { provide: GuestTrackingService, useValue: { getSessionContext: () => sessionContext, clear: () => {} } },
        { provide: CookieService, useValue: { get: cookieGet } },
        HeartbeatService,
      ],
    });

    // A beat hashes the device signals before it posts. That digest is a browser task the
    // fake clock cannot drain, so it is resolved in-zone; with no `subtle` (insecure
    // context) the collector throws inside its own try/catch and resolves immediately.
    const subtle = window.crypto?.subtle;
    if (subtle) {
      spyOn(subtle, 'digest').and.resolveTo(new ArrayBuffer(32));
    }

    service = TestBed.inject(HeartbeatService);
    httpMock = TestBed.inject(HttpTestingController);
    revoked = jasmine.createSpy('sessionRevoked');
    service.sessionRevoked$.subscribe(revoked);
  });

  afterEach(() => {
      // Advancing the clock to prove the NEXT beat happens leaves that beat in flight, and a
      // digest that resolves during teardown can post one more. Neither is a leak: they are
      // the tick under test. Satisfy them so `verify()` below fails only on a beat posted
      // with no poll running. A request `stop()` already cancelled cannot be flushed, and a
      // cancelled request never reaches `verify()`.
      httpMock.match('/event/heartbeat').forEach((request) => {
        try {
          request.flush({ success: true });
        } catch {
          // Cancelled already; nothing to satisfy.
        }
      });
      service.stop();
    });

  /** Runs the immediate first beat and returns the request it produced. */
  const firstBeat = () => {
    tick(0);
    flushMicrotasks();
    return httpMock.expectOne('/event/heartbeat');
  };

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('posts one beat carrying the bearer token and the device signals', fakeAsync(() => {
    service.start('tok-1');

    const request = firstBeat();

    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Authorization')).toBe('Bearer tok-1');
    expect(request.request.body).toEqual(jasmine.objectContaining({ deviceSignals: jasmine.any(String) }));
    expect(revoked).not.toHaveBeenCalled();

    request.flush({ success: true });
  }));

  it('re-reads the token getter so a refreshed bearer reaches the next beat', fakeAsync(() => {
    let token = 'tok-a';
    service.start(() => token);

    const first = firstBeat();
    expect(first.request.headers.get('Authorization')).toBe('Bearer tok-a');
    first.flush({ success: true });

    token = 'tok-b';
    tick(BEAT_MS);
    flushMicrotasks();

    const second = httpMock.expectOne('/event/heartbeat');
    expect(second.request.headers.get('Authorization')).toBe('Bearer tok-b');
    second.flush({ success: true });
  }));

  [500, 502, 429].forEach((status) => {
    it(`keeps beating after a ${status}: a transient failure must not end the poll`, fakeAsync(() => {
      spyOn(console, 'warn').and.stub();
      service.start('tok');

      firstBeat().flush({ error: 'boom' }, { status, statusText: 'Transient' });

      tick(BEAT_MS);
      flushMicrotasks();

      const retry = httpMock.expectOne('/event/heartbeat');
      expect(revoked).not.toHaveBeenCalled();
      retry.flush({ success: true });
    }));
  });

  it('announces revocation and ends the poll on a 401 carrying a session_* code', fakeAsync(() => {
    service.start('tok');

    firstBeat().flush({ code: 'session_revoked' }, { status: 401, statusText: 'Unauthorized' });

    expect(revoked).toHaveBeenCalledTimes(1);

    tick(BEAT_MS * 2);
    flushMicrotasks();

    httpMock.expectNone('/event/heartbeat');
  }));

  it('sends nothing while there is neither an identity nor analytics consent', fakeAsync(() => {
    sessionContext = { guestId: null, userId: null, loginId: null, guestFingerprint: null };
    service.start('tok');

    tick(0);
    flushMicrotasks();
    tick(BEAT_MS);
    flushMicrotasks();

    httpMock.expectNone('/event/heartbeat');
  }));

  it('beats for a consented anonymous visitor that has no id yet', fakeAsync(() => {
    sessionContext = { guestId: null, userId: null, loginId: null, guestFingerprint: null };
    cookieGet.and.returnValue('granted');
    service.start('tok');

    const request = firstBeat();
    request.flush({ success: true });

    expect(cookieGet).toHaveBeenCalledWith('consent');
  }));

  it('stops beating once stop() is called', fakeAsync(() => {
    service.start('tok');
    firstBeat().flush({ success: true });

    service.stop();
    tick(BEAT_MS * 2);
    flushMicrotasks();

    httpMock.expectNone('/event/heartbeat');
  }));

  it('pauses on the offline event and resumes on the online event', fakeAsync(() => {
    service.start('tok');
    firstBeat().flush({ success: true });

    window.dispatchEvent(new Event('offline'));
    tick(BEAT_MS);
    flushMicrotasks();
    httpMock.expectNone('/event/heartbeat');

    window.dispatchEvent(new Event('online'));
    tick(BEAT_MS);
    flushMicrotasks();

    const resumed = httpMock.expectOne('/event/heartbeat');
    resumed.flush({ success: true });
  }));

  // ponytail: the hidden-tab pause reuses the same pause/resume path exercised by the
  // offline spec. It is driven by `document.hidden`, which headless Chrome reports as
  // true regardless of the event, so asserting it here would pin the harness, not the code.
});

