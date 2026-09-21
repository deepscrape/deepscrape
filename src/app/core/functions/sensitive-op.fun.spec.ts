import { AuthErrorCodes } from '@angular/fire/auth';

import { isStaleCredentialError, retryOnceAfterFreshCredential } from './sensitive-op.fun';

// The value the SDK really produces for CREDENTIAL_TOO_OLD_LOGIN_AGAIN. Pinning the constant
// (rather than the literal) means a rename in the SDK fails here instead of silently
// disabling the re-authentication in front of MFA enrolment.
describe('isStaleCredentialError', () => {
  it('recognises the mapped auth code', () => {
    expect(isStaleCredentialError({ code: AuthErrorCodes.CREDENTIAL_TOO_OLD_LOGIN_AGAIN })).toBe(true);
  });

  it('recognises the raw server code inside a message', () => {
    expect(isStaleCredentialError({ message: 'CREDENTIAL_TOO_OLD_LOGIN_AGAIN : Please login again' })).toBe(true);
  });

  it('ignores unrelated failures', () => {
    expect(isStaleCredentialError({ code: 'auth/too-many-requests' })).toBe(false);
    expect(isStaleCredentialError({ code: 'auth/wrong-password' })).toBe(false);
    expect(isStaleCredentialError(undefined)).toBe(false);
    expect(isStaleCredentialError(null)).toBe(false);
    expect(isStaleCredentialError('boom')).toBe(false);
  });
});

describe('retryOnceAfterFreshCredential', () => {
  it('refreshes the credential and retries exactly once', async () => {
    let attempts = 0;
    const operation = () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject({ code: AuthErrorCodes.CREDENTIAL_TOO_OLD_LOGIN_AGAIN })
        : Promise.resolve('retried');
    };
    const refresh = jasmine.createSpy('refresh').and.resolveTo(true);

    await expectAsync(retryOnceAfterFreshCredential(operation, refresh)).toBeResolvedTo('retried');

    expect(attempts).toBe(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not touch the credential for an unrelated failure', async () => {
    const operation = jasmine.createSpy('operation').and.rejectWith({ code: 'auth/too-many-requests' });
    const refresh = jasmine.createSpy('refresh').and.resolveTo(true);

    await expectAsync(retryOnceAfterFreshCredential(operation, refresh)).toBeRejected();

    expect(operation).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('surfaces the original error when the session cannot be refreshed', async () => {
    const stale = { code: AuthErrorCodes.CREDENTIAL_TOO_OLD_LOGIN_AGAIN };
    const operation = jasmine.createSpy('operation').and.rejectWith(stale);
    const refresh = jasmine.createSpy('refresh').and.resolveTo(false);

    await expectAsync(retryOnceAfterFreshCredential(operation, refresh)).toBeRejectedWith(stale);

    expect(operation).toHaveBeenCalledTimes(1);
  });
});
