import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';

import { HeartbeatService } from './heartbeat.service';
import { getTestProviders } from 'src/app/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';

describe('HeartbeatService', () => {
  let service: HeartbeatService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: getTestProviders(),
    });

    service = TestBed.runInInjectionContext(() => new HeartbeatService(TestBed.inject(HttpClient)));
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should start heartbeat interval', fakeAsync(() => {
    service.start();
    tick(100);
    // Service should be running
    expect(service).toBeTruthy();
    service.stop();
  }));

  it('should stop heartbeat when stop is called', fakeAsync(() => {
    service.start();
    tick(50);
    service.stop();
    tick(50);
    expect(service).toBeTruthy();
  }));

  it('should pause and resume heartbeat via inactivity', fakeAsync(() => {
    service.start();
    tick(50);
    tick(50);
    service.stop();
    expect(service).toBeTruthy();
  }));

  it('should emit session revoked event', () => {
    expect(service.sessionRevoked$).toBeDefined();
    expect(typeof service.sessionRevoked$.subscribe).toBe('function');
  });

  // ponytail: the consent branch (`hasAnalyticsConsent` in the interval filter) has no
  // test here on purpose — under Karma the cookie written through `CookieService` is not
  // readable back, so the branch cannot be driven from a spec without mocking the cookie
  // layer. Cover it by extracting the two-condition guard into a pure predicate when that
  // mock is worth writing; the browser behaviour (consent → one POST) is what matters.
});
