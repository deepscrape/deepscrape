import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';

import { SessionTimeoutService } from './session-timeout.service';
import { AuthService } from './auth.service';
import { SnackbarService } from './snackbar.service';
import { SnackBarType } from '../components/snackbar/snackbar.component';

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

describe('SessionTimeoutService', () => {
  let expiresAt$: BehaviorSubject<number | null>;
  let revoke: jasmine.Spy;
  let snackbar: jasmine.SpyObj<SnackbarService>;

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date('2026-10-21T10:00:00.000Z'));

    expiresAt$ = new BehaviorSubject<number | null>(null);
    revoke = jasmine.createSpy('onSessionRevoked');
    snackbar = jasmine.createSpyObj('SnackbarService', ['showSnackbar']);

    TestBed.configureTestingModule({
      providers: [
        SessionTimeoutService,
        {
          provide: AuthService,
          useValue: { sessionExpiresAt$: expiresAt$, onSessionRevoked: revoke },
        },
        { provide: SnackbarService, useValue: snackbar },
        { provide: TranslateService, useValue: { instant: (key: string) => key } },
      ],
    });
  });

  afterEach(() => {
    jasmine.clock().uninstall();
  });

  it('should be created', () => {
    expect(TestBed.inject(SessionTimeoutService)).toBeTruthy();
  });

  // The removed counter derived 30 days from its own construction, so it named an expiry the
  // session never had. With no expiry from the server there is nothing to announce.
  it('counts nothing down while the server has reported no expiry', () => {
    TestBed.inject(SessionTimeoutService);

    jasmine.clock().tick(31 * DAY_MS);

    expect(snackbar.showSnackbar).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('warns once, five minutes before the reported expiry', () => {
    TestBed.inject(SessionTimeoutService);
    expiresAt$.next(Date.now() + HOUR_MS);

    jasmine.clock().tick(54 * MIN_MS);
    expect(snackbar.showSnackbar).not.toHaveBeenCalled();

    jasmine.clock().tick(2 * MIN_MS);
    expect(snackbar.showSnackbar).toHaveBeenCalledWith(
      'SESSION_TIMEOUT.WARNING',
      SnackBarType.warning,
    );
    expect(revoke).not.toHaveBeenCalled();

    jasmine.clock().tick(2 * MIN_MS);
    expect(snackbar.showSnackbar).toHaveBeenCalledTimes(1); // once, not per wake-up
  });

  it('signs out at the reported expiry instead of only showing a toast', () => {
    TestBed.inject(SessionTimeoutService);
    expiresAt$.next(Date.now() + 10 * MIN_MS);

    jasmine.clock().tick(10 * MIN_MS);

    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('signs out at once when the reported expiry has already passed', () => {
    TestBed.inject(SessionTimeoutService);

    expiresAt$.next(Date.now() - 1000);

    expect(revoke).toHaveBeenCalledTimes(1);
  });

  // 30 days exceeds setTimeout's 2^31-1 ms ceiling, where a single long timer fires at once.
  it('waits out an expiry beyond the setTimeout ceiling instead of firing immediately', () => {
    TestBed.inject(SessionTimeoutService);
    expiresAt$.next(Date.now() + 30 * DAY_MS);

    jasmine.clock().tick(20 * DAY_MS);
    expect(snackbar.showSnackbar).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();

    jasmine.clock().tick(11 * DAY_MS);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('forgets the previous expiry when a new session reports none', () => {
    TestBed.inject(SessionTimeoutService);
    expiresAt$.next(Date.now() + 10 * MIN_MS);

    expiresAt$.next(null);
    jasmine.clock().tick(30 * MIN_MS);

    expect(revoke).not.toHaveBeenCalled();
  });
});

