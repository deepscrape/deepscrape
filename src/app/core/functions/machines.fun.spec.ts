import { HttpErrorResponse } from '@angular/common/http';

import { MineMachine } from '../types/machine-fleet.interface';
import { describeMachineFailure, hasSessionBacking, sessionOwning } from './machines.fun';

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

/**
 * The rule deciding whether a machine may be acted on.
 *
 * Tested here rather than through either caller, because there are now TWO of them -- the
 * machines page and the chat's machine tools -- and a rule with two callers is a rule that
 * can drift between them. What it prevents: a customer left paying for a browser session
 * whose machine was stopped out from under it, with nothing left to connect to.
 */
describe('session backing', () => {
  /** A row with the fields `GET /api/machines` projects, overridable per case. */
  const row = (over: Partial<MineMachine>): MineMachine => ({
    id: 'm-1',
    name: 'm-1',
    state: 'started',
    region: 'fra',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'container',
    ...over,
  });

  it('counts a session row that carries a session id', () => {
    const machine = row({ kind: 'browser-session', sessionId: 'sess-1' });
    expect(hasSessionBacking(machine)).toBeTrue();
  });

  it('does NOT count a session row with no session id', () => {
    // The case with teeth. Such a row has no session entry to hand the user, so refusing
    // an action on it would refuse and offer nothing back.
    expect(hasSessionBacking(row({ kind: 'browser-session' }))).toBeFalse();
  });

  it('ignores the machine NAME, which nothing enforces', () => {
    // `bs-` looks like it means session-owned. It does not: this data decides whether a
    // destructive action is offered, so it reads the field rather than the name.
    expect(hasSessionBacking(row({ id: 'bs-9', name: 'bs-9' }))).toBeFalse();
  });

  it('ignores a stray session id on a non-session row', () => {
    // Both conditions, not either: a container that somehow carries a sessionId is still
    // a container, and its lifecycle belongs to the console.
    expect(hasSessionBacking(row({ kind: 'container', sessionId: 'sess-1' }))).toBeFalse();
  });

  it('names the owning session, so a refusal can route the caller somewhere', () => {
    const machines = [
      row({ id: 'bs-1', kind: 'browser-session', sessionId: 'sess-1' }),
      row({ id: 'crawl-1' }),
    ];

    expect(sessionOwning('bs-1', machines)).toBe('sess-1');
    expect(sessionOwning('crawl-1', machines)).toBeUndefined();
    // An id the caller does not own is simply absent here; the route answers 404 rather
    // than this function guessing about a machine it cannot see.
    expect(sessionOwning('never-seen', machines)).toBeUndefined();
  });
});
