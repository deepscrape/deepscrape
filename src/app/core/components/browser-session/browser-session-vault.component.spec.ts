import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { BrowserSessionService } from '../../services/browser-session.service';
import { ToolEnvelope } from '../../types';
import { getTestProviders } from 'src/app/testing';
import { BrowserSessionVaultComponent } from './browser-session-vault.component';

// What this pins, and why these two things:
//
// 1. `entriesFrom` — the payload parser. The worker owns that shape and the
//    gateway passes it through unmodelled, so a reply that is not the array we
//    expect must degrade to "no entries" rather than throwing in a template.
// 2. The 402 and 403 branches -- the entitlement boundary. A 402 means
//    "upgrade", every other failure means "try again", and collapsing the two
//    would either hide a paid feature behind a generic error or show an upgrade
//    prompt to someone whose worker merely timed out. The 403 is a third case
//    again: the gateway refuses these ops for every non-admin tier, so it is
//    neither an upgrade nor something a retry can fix.
//
// Class-level assertions, not rendered ones: the template needs Router and a
// translate bundle, neither of which this logic depends on.

describe('BrowserSessionVaultComponent', () => {
  let fixture: ComponentFixture<BrowserSessionVaultComponent>;
  let replies: Subject<ToolEnvelope>;
  let vault: jasmine.Spy;

  /** The component, with its protected members readable. */
  const state = () => fixture.componentInstance as any;

  beforeEach(async () => {
    replies = new Subject<ToolEnvelope>();
    vault = jasmine.createSpy('vault').and.returnValue(replies.asObservable());

    await TestBed.configureTestingModule({
      imports: [BrowserSessionVaultComponent],
      providers: [
        ...getTestProviders(),
        { provide: BrowserSessionService, useValue: { vault } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(BrowserSessionVaultComponent);
  });

  it('asks for the vault names on construction', () => {
    expect(vault).toHaveBeenCalledWith({ op: 'profiles' });
  });

  it('reads the entries it recognises and drops the rest', () => {
    replies.next({
      data: [
        { service: 'github', profile: 'work', username: 'me' },
        { nope: 1 },
        'junk',
      ],
    });

    const entries = state().entries();
    expect(entries.length).toBe(1);
    expect(entries[0].service).toBe('github');
    expect(entries[0].profile).toBe('work');
    expect(entries[0].username).toBe('me');
    expect(state().loading()).toBeFalse();
  });

  it('treats a payload that is not an array as no entries', () => {
    // The shape is the worker's contract; a surprise must not throw.
    expect(() => replies.next({ data: { unexpected: true } })).not.toThrow();
    expect(state().entries()).toEqual([]);
  });

  it('treats a 402 as an upgrade, not a failure', () => {
    replies.error(new HttpErrorResponse({ status: 402 }));

    expect(state().upgradeRequired()).toBeTrue();
    expect(state().failure()).toBeNull();
  });

  it('treats any other failure as a message, not an upgrade', () => {
    replies.error(new HttpErrorResponse({ status: 500 }));

    expect(state().upgradeRequired()).toBeFalse();
    expect(state().failure()).toBe('VAULT.FAILED');
  });

  it('reports a 403 as a permanent refusal, not a retry', () => {
    // The gateway refuses the vault ops for every non-admin tier because no
    // caller has a worker of its own yet (`VAULT_TOOLS` in
    // `webrain-tools.domain.ts`). So neither remedy advertised on this panel
    // applies: retrying cannot help, and the upgrade prompt is actively wrong
    // -- a paid caller receives this same 403.
    replies.error(new HttpErrorResponse({ status: 403 }));

    expect(state().upgradeRequired()).toBeFalse();
    expect(state().failure()).toBe('VAULT.NO_PRIVATE_WORKER');
  });
});
