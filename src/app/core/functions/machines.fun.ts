import { HttpErrorResponse } from '@angular/common/http';

// The concrete file, not the `../types` barrel: the barrel exports `machine.interface`
// rather than `machine-fleet.interface`, and every existing consumer of these types
// imports them this way.
import { MineMachine } from '../types/machine-fleet.interface';

/**
 * Whether a browser session owns this machine.
 *
 * The rule, in ONE place. It was inline in `MachinesComponent.loadMachineKinds`, which
 * meant the only caller able to apply it was the page that built the map -- and the
 * chat's machine tools need the same answer.
 *
 * Two conditions, and the second is the one with teeth: a `browser-session` row that
 * carries NO `sessionId` is deliberately not session-owned. Such a row has no session
 * entry to hand the user, so refusing an action on it would refuse and offer nothing
 * back -- the customer would be left with a machine they cannot act on and no reason why.
 *
 * Deliberately not the `bs-` name prefix, which nothing enforces.
 *
 * Typed as a predicate so a caller that reads `sessionId` afterwards gets it narrowed to
 * a string instead of casting.
 * @param {MineMachine} machine One row, as `GET /api/machines` projects it.
 * @return {boolean} True when a session backs it.
 */
export function hasSessionBacking(
  machine: MineMachine,
): machine is MineMachine & { sessionId: string } {
  return machine.kind === 'browser-session' && Boolean(machine.sessionId);
}

/**
 * The session that owns a machine, from the caller's own list.
 *
 * Returns the session ID rather than a boolean because a caller that refuses an action
 * should be able to say WHICH session to end instead: the machines page points at the
 * panel, and the chat tool sends the model to `stop_session`.
 * @param {string} machineId The machine an action targeted.
 * @param {readonly MineMachine[]} machines The caller's machines, as read.
 * @return {string|undefined} The owning session id, or undefined when none owns it.
 */
export function sessionOwning(
  machineId: string,
  machines: readonly MineMachine[],
): string | undefined {
  const machine = machines.find(candidate => candidate.id === machineId);

  return machine && hasSessionBacking(machine) ? machine.sessionId : undefined;
}

/** How a refused machine action should be reported to the caller. */
export interface MachineFailure {
  /** i18n key for the message. */
  key: string;
  /** Whether trying the same action again could plausibly succeed. */
  retryable: boolean;
}

/**
 * Turn an arachnefly refusal into copy a person can act on.
 *
 * The backend already separates a capacity refusal from a real failure, and that
 * separation is the whole point: `Create Machine` is limited per APP at roughly one
 * per second and every tenant shares the app, so a 503 means "the platform is full,
 * wait" while a 502 means "this deploy is broken". Reporting both as "failed" tells
 * the customer to investigate something that is not wrong.
 *
 * The deploy path also used to pass the raw error object into the snackbar, which
 * renders as `[object Object]`, so this exists to stop that too.
 *
 * @param {unknown} error The value handed to a subscription's error handler.
 * @return {MachineFailure} The message key, and whether to offer a retry.
 */
export function describeMachineFailure(error: unknown): MachineFailure {
  const status = error instanceof HttpErrorResponse ? error.status : 0;

  switch (status) {
    case 402:
      return { key: 'MACHINES.PLAN', retryable: false };
    case 403:
      return { key: 'MACHINES.FORBIDDEN', retryable: false };
    case 502:
      return { key: 'MACHINES.UPSTREAM_FAILED', retryable: false };
    case 503:
      return { key: 'MACHINES.CAPACITY', retryable: true };
    default:
      // Status 0 is a request that never landed, so a retry is worth offering, and
      // so is anything unrecognised: refusing a retry costs the user more than
      // offering one that fails again.
      return { key: 'MACHINES.ACTION_FAILED', retryable: true };
  }
}
