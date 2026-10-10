import { HttpErrorResponse } from '@angular/common/http';

import { describeMachineFailure } from './machines.fun';

/**
 * What matters here is not the mapping table but the two things a reader would
 * otherwise have to trust: that a capacity refusal is NOT reported as a failure,
 * and that an unknown error is never reported as something it is not.
 */
describe('describeMachineFailure', () => {
  /** An HTTP failure carrying only the status, which is all this reads. */
  const httpError = (status: number): HttpErrorResponse =>
    new HttpErrorResponse({ status });

  it('reads 503 as capacity and offers a retry', () => {
    expect(describeMachineFailure(httpError(503))).toEqual({
      key: 'MACHINES.CAPACITY',
      retryable: true,
    });
  });

  it('keeps 502 a real failure, NOT capacity', () => {
    // The whole reason this function exists: the two must not collapse.
    const result = describeMachineFailure(httpError(502));
    expect(result.key).toBe('MACHINES.UPSTREAM_FAILED');
    expect(result.key).not.toBe('MACHINES.CAPACITY');
    expect(result.retryable).toBeFalse();
  });

  it('separates a permission refusal from a plan boundary', () => {
    expect(describeMachineFailure(httpError(403)).key).toBe('MACHINES.FORBIDDEN');
    expect(describeMachineFailure(httpError(402)).key).toBe('MACHINES.PLAN');
  });

  it('treats a request that never landed as retryable', () => {
    const result = describeMachineFailure(httpError(0));
    expect(result.key).toBe('MACHINES.ACTION_FAILED');
    expect(result.retryable).toBeTrue();
  });

  it('does not throw on a value that is not an HTTP error', () => {
    // A thrown string or a plain Error is what a client-side bug looks like, and the
    // snackbar must still get a key rather than an object.
    expect(describeMachineFailure(new Error('boom')).key).toBe('MACHINES.ACTION_FAILED');
    expect(describeMachineFailure(undefined).key).toBe('MACHINES.ACTION_FAILED');
  });
});
