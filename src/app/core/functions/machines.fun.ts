import { HttpErrorResponse } from '@angular/common/http';

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
