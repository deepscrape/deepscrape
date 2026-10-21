import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, Subject } from 'rxjs';
import type { User } from '@angular/fire/auth';

import { AuthService } from './auth.service';
import { FirestoreService } from './firestore.service';
import { HeartbeatService } from './heartbeat.service';
import { GuestTrackingService } from './guest-tracking.service';
import { Users } from '../types';
import { getTestProviders } from 'src/app/testing';

describe('AuthService', () => {
  let service: AuthService;
  let firestoreMock: jasmine.SpyObj<Pick<FirestoreService, 'authState' | 'getUserData' | 'isLocalhost'>>;
  let heartbeatMock: { start: jasmine.Spy, stop: jasmine.Spy, sessionRevoked$: Subject<void> };
  let guestTrackingMock: { getSessionContext: jasmine.Spy, clear: jasmine.Spy };

  /** A Firebase user stub: only the members `isAuthenticated()` actually reads. */
  const makeUser = (claims: Record<string, unknown> = { role: 'admin' }): User => ({
    uid: 'uid-1',
    email: 'user@example.com',
    emailVerified: true,
    phoneNumber: null,
    providerId: 'firebase',
    providerData: [],
    getIdToken: jasmine.createSpy('getIdToken').and.resolveTo('tok-1'),
    getIdTokenResult: jasmine.createSpy('getIdTokenResult').and.resolveTo({ claims }),
  }) as unknown as User;

  const profile = (overrides: Partial<Users> = {}): Users => ({
    uid: 'uid-1',
    username: 'tester',
    email: 'user@example.com',
    role: 'admin',
    providerId: 'password',
    providerParent: 'firebase',
    providerData: [],
    emailVerified: true,
    ...overrides,
  }) as unknown as Users;

  beforeEach(() => {
    spyOn(console, 'log').and.stub();

    firestoreMock = jasmine.createSpyObj<Pick<FirestoreService, 'authState' | 'getUserData' | 'isLocalhost'>>(
      'FirestoreService',
      ['authState', 'getUserData', 'isLocalhost'],
    );
    firestoreMock.authState.and.returnValue(of(null));
    firestoreMock.getUserData.and.resolveTo(null);
    firestoreMock.isLocalhost.and.returnValue(false);

    heartbeatMock = {
      start: jasmine.createSpy('heartbeat.start'),
      stop: jasmine.createSpy('heartbeat.stop'),
      sessionRevoked$: new Subject<void>(),
    };

    guestTrackingMock = {
      getSessionContext: jasmine.createSpy('getSessionContext').and.returnValue({
        guestFingerprint: null, guestId: null, loginId: null, userId: null,
      }),
      clear: jasmine.createSpy('clear'),
    };

    TestBed.configureTestingModule({
      providers: [
        ...getTestProviders(),
        { provide: FirestoreService, useValue: firestoreMock },
        { provide: HeartbeatService, useValue: heartbeatMock },
        { provide: GuestTrackingService, useValue: guestTrackingMock },
        // Overrides the mock AuthService from getTestProviders: these specs are about the
        // real one.
        AuthService,
      ],
    });

    service = TestBed.inject(AuthService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should expose auth state observables', () => {
    expect(typeof service.isAuthenticated).toBe('function');
    expect(service.user$).toBeDefined();
  });

  it('should initialize with non-admin flag by default', () => {
    expect(service.isAdmin).toBe(false);
  });

  it('answers authenticated with the combined profile and caches the bearer token', async () => {
    const user = makeUser({ role: 'admin' });
    firestoreMock.authState.and.returnValue(of(user));
    firestoreMock.getUserData.and.resolveTo(profile());

    const result = await firstValueFrom(service.isAuthenticated());

    expect(result.isAuthenticated).toBe(true);
    expect(result.user?.uid).toBe('uid-1');
    expect(service.token).toBe('tok-1');
    // The admin role claim is what flips the flag.
    expect(service.isAdmin).toBe(true);
    expect(heartbeatMock.start).toHaveBeenCalledTimes(1);
    expect(heartbeatMock.stop).not.toHaveBeenCalled();
    expect(await firstValueFrom(service.isAuthStateResolved)).toBe(true);
  });

  it('answers unauthenticated and stops the heartbeat when Firebase has no user', async () => {
    firestoreMock.authState.and.returnValue(of(null));

    const result = await firstValueFrom(service.isAuthenticated());

    expect(result).toEqual({ isAuthenticated: false, user: null });
    expect(service.token).toBeUndefined();
    expect(service.isAdmin).toBe(false);
    expect(heartbeatMock.stop).toHaveBeenCalledTimes(1);
    expect(heartbeatMock.start).not.toHaveBeenCalled();
    expect(await firstValueFrom(service.isAuthStateResolved)).toBe(false);
  });

  it('turns a missing profile into an unauthenticated answer and clears the token it had already cached', async () => {
    const user = makeUser();
    firestoreMock.authState.and.returnValue(of(user));
    firestoreMock.getUserData.and.resolveTo(null);

    const result = await firstValueFrom(service.isAuthenticated());

    expect(result).toEqual({ isAuthenticated: false, user: null });
    // The token was cached before the profile lookup threw; the error branch must undo it.
    expect(user.getIdToken).toHaveBeenCalled();
    expect(service.token).toBeUndefined();
    expect(service.isAdmin).toBe(false);
    expect(await firstValueFrom(service.user$)).toBeNull();
    expect(await firstValueFrom(service.isAuthStateResolved)).toBe(false);
  });
});

