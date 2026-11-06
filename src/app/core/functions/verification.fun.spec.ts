import { RESEND_COOLDOWN_MS, formatWait, resendStampKey, resendWaitMs } from './verification.fun';

describe('resendWaitMs', () => {
  const now = 1_000_000_000_000;

  it('allows a send when nothing has been sent', () => {
    expect(resendWaitMs(null, now)).toBe(0);
    expect(resendWaitMs(0, now)).toBe(0);
  });

  it('holds the button for the full cooldown right after an accepted send', () => {
    // The case the whole rule exists for: pressing Resend twice in a row.
    expect(resendWaitMs(now, now)).toBe(RESEND_COOLDOWN_MS);
    expect(resendWaitMs(now, now + 60_000)).toBe(RESEND_COOLDOWN_MS - 60_000);
  });

  it('releases the button once the window has passed', () => {
    // Exactly at the boundary and well past it: the button must never be stuck.
    expect(resendWaitMs(now, now + RESEND_COOLDOWN_MS)).toBe(0);
    expect(resendWaitMs(now, now + RESEND_COOLDOWN_MS * 3)).toBe(0);
  });

  it('caps a stamp from the future instead of locking the button for hours', () => {
    // A clock moved backwards must cost at most one cooldown, not the whole skew.
    expect(resendWaitMs(now + RESEND_COOLDOWN_MS * 10, now)).toBe(RESEND_COOLDOWN_MS);
    expect(resendWaitMs(now + 60_000, now)).toBe(RESEND_COOLDOWN_MS);
  });
});

describe('resendStampKey', () => {
  it('scopes the stamp to one account', () => {
    expect(resendStampKey('user-a')).not.toBe(resendStampKey('user-b'));
  });
});

describe('formatWait', () => {
  it('renders minutes and zero-padded seconds', () => {
    expect(formatWait(0)).toBe('0:00');
    expect(formatWait(247_000)).toBe('4:07');
    // Rounds UP, so a button says "0:01" rather than "0:00" while it is still disabled.
    expect(formatWait(200)).toBe('0:01');
  });
});
