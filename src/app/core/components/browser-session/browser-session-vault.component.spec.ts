import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { BrowserSessionService } from '../../services/browser-session.service';
import { VaultDurableReply } from '../../types/browser-session.interface';
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
//    again: the gateway refuses the worker's entry ops for every non-admin tier,
//    so it is neither an upgrade nor something a retry can fix.
//
// And the part that only exists because there are TWO stores: the cookie pair is
// a COMPOSITION, so its order is the contract. `keep` must read the worker before
// it writes the account, and `restore` must read the account before it writes the
// worker -- reversed, either one stores an empty jar under a real name.
//
// Class-level assertions, not rendered ones: the template needs Router and a
// translate bundle, neither of which this logic depends on.

describe('BrowserSessionVaultComponent', () => {
  let fixture: ComponentFixture<BrowserSessionVaultComponent>;
  /** One replier per `op`, so a test drives the call it means and not the first. */
  let worker: Record<string, Subject<ToolEnvelope>>;
  let durable: Record<string, Subject<VaultDurableReply>>;
  let vault: jasmine.Spy;
  let durableVault: jasmine.Spy;

  /** The component, with its protected members readable. */
  const state = () => fixture.componentInstance as any;

  /**
   * A reply channel keyed by the op that opens it.
   *
   * Keyed rather than indexed: `keep` and `restore` each fire twice, and an
   * index would silently follow call order instead of the op under test.
   * @param {Record<string, unknown>} bodies The captured request bodies.
   * @param {Record<string, Subject<never>>} channels Where to put the channel.
   * @return {jasmine.Spy} The spy to install.
   */
  function opener(
    bodies: Record<string, unknown>[],
    channels: Record<string, Subject<never>>
  ): jasmine.Spy {
    return jasmine
      .createSpy('opener')
      .and.callFake((body: Record<string, unknown>) => {
        bodies.push(body);
        const channel = new Subject<never>();
        channels[String(body['op'])] = channel;
        return channel.asObservable();
      });
  }

  let workerBodies: Record<string, unknown>[];
  let durableBodies: Record<string, unknown>[];

  /**
   * The body of the last request that named this op.
   *
   * Throws rather than asserting, so a missing request reads as one clear
   * failure instead of an expectation followed by a TypeError on `undefined`.
   * @param {Record<string, unknown>[]} bodies Every body that was sent.
   * @param {string} op The op to find.
   * @return {Record<string, unknown>} That request's body.
   */
  const bodyFor = (
    bodies: Record<string, unknown>[],
    op: string
  ): Record<string, unknown> => {
    const matches = bodies.filter((body) => body['op'] === op);
    if (matches.length === 0) {
      throw new Error(`no ${op} request was made`);
    }
    return matches[matches.length - 1];
  };

  /** The form's values, as the buttons read them. */
  const fill = (values: Record<string, string>): void => {
    state().form.patchValue(values);
  };

  beforeEach(async () => {
    worker = {};
    durable = {};
    workerBodies = [];
    durableBodies = [];
    vault = opener(
      workerBodies,
      worker as unknown as Record<string, Subject<never>>
    );
    durableVault = opener(
      durableBodies,
      durable as unknown as Record<string, Subject<never>>
    );

    await TestBed.configureTestingModule({
      imports: [BrowserSessionVaultComponent],
      providers: [
        ...getTestProviders(),
        { provide: BrowserSessionService, useValue: { vault, durableVault } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(BrowserSessionVaultComponent);
  });

  it('asks for the vault names on construction', () => {
    expect(vault).toHaveBeenCalledWith({ op: 'profiles' });
    expect(durableVault).toHaveBeenCalledWith({ op: 'list' });
  });

  it('reads the entries it recognises and drops the rest', () => {
    worker['profiles'].next({
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
    expect(() =>
      worker['profiles'].next({ data: { unexpected: true } })
    ).not.toThrow();
    expect(state().entries()).toEqual([]);
  });

  it('treats a 402 as an upgrade, not a failure', () => {
    worker['profiles'].error(new HttpErrorResponse({ status: 402 }));

    expect(state().upgradeRequired()).toBeTrue();
    expect(state().failure()).toBeNull();
  });

  it('treats any other failure as a message, not an upgrade', () => {
    worker['profiles'].error(new HttpErrorResponse({ status: 500 }));

    expect(state().upgradeRequired()).toBeFalse();
    expect(state().failure()).toBe('VAULT.FAILED');
  });

  it('reports a 403 as a permanent refusal, not a retry', () => {
    // The gateway refuses the worker's ENTRY ops for every non-admin tier
    // because no caller has a worker of its own yet (`VAULT_TOOLS` in
    // `webrain-tools.domain.ts`). So neither remedy advertised on this panel
    // applies: retrying cannot help, and the upgrade prompt is actively wrong
    // -- a paid caller receives this same 403.
    worker['profiles'].error(new HttpErrorResponse({ status: 403 }));

    expect(state().upgradeRequired()).toBeFalse();
    expect(state().failure()).toBe('VAULT.NO_PRIVATE_WORKER');
  });

  it('reads the account list, and drops a row it could not address', () => {
    // The cast IS the wire boundary, not a shortcut: the BFF and the functions
    // deploy separately, so a route one version ahead can answer rows this
    // type does not describe. The parser is defensive for that case, and this
    // is how such a body arrives.
    durable['list'].next({
      entries: [
        { service: 'github', profile: 'work', updatedAtMs: 1 },
        // No profile: every action on it would fail, so it is not a row.
        { service: 'github' },
        'junk',
      ],
    } as unknown as VaultDurableReply);

    const rows = state().durable();
    expect(rows.length).toBe(1);
    expect(rows[0].profile).toBe('work');
    expect(rows[0].updatedAtMs).toBe(1);
  });

  it('reads a missing account list as no rows rather than throwing', () => {
    expect(() => durable['list'].next({})).not.toThrow();
    expect(state().durable()).toEqual([]);
  });

  it('keeps the worker jar under the account, as the array setcookies needs', () => {
    // The REAL reply shape, which is the point of this test. `webrain_cookies`
    // answers `{status, count, cookies: [...]}` while `webrain_setcookies` calls
    // `as_array()` on `cookies` and refuses anything else -- so a component that
    // forwarded the reply verbatim would store a jar it could never restore, and
    // every symptom would appear on the RESTORE path.
    const jar = [{ name: 'sid', value: 'v' }];
    fill({ service: 'github', profile: 'work' });

    state().keep();
    // Reading the browser and writing the account are one flow, and the write
    // cannot happen before the read has an answer.
    expect(durableBodies.length).toBe(1); // only the constructor's `list`
    worker['cookies'].next({
      status: 'ok',
      data: { status: 'ok', count: 1, cookies: jar },
    });

    expect(bodyFor(durableBodies, 'store')).toEqual({
      op: 'store',
      service: 'github',
      profile: 'work',
      payload: jar,
    });
  });

  it('refuses to keep an empty jar instead of sending one', () => {
    fill({ service: 'github', profile: 'work' });
    state().keep();
    worker['cookies'].next({
      status: 'ok',
      data: { status: 'ok', count: 0, cookies: [] },
    });

    expect(state().failure()).toBe('VAULT.NOTHING_TO_KEEP');
    // The route would have answered 400, which reads as "malformed request".
    expect(durableBodies.some((body) => body['op'] === 'store')).toBeFalse();
  });

  it('names the caller own browser for the cookie pair, trimmed', () => {
    fill({ service: 'github', profile: 'work', cdp_url: '  ws://1.2.3.4:9222  ' });
    state().keep();

    // Trimmed, because the route refuses a supplied-but-unusable address rather
    // than dropping it.
    expect(bodyFor(workerBodies, 'cookies')['cdp_url']).toBe(
      'ws://1.2.3.4:9222'
    );
  });

  it('leaves the browser address out entirely when blank', () => {
    // ABSENT, not empty: the route refuses a named-but-unusable address, so an
    // empty string would be read as a browser the caller never named.
    fill({ service: 'github', profile: 'work', cdp_url: '   ' });
    state().closeLaunch();

    expect(bodyFor(workerBodies, 'close_launch')['cdp_url']).toBeUndefined();
  });

  it('puts a kept jar back as a bare array, account first', () => {
    const jar = [{ name: 'sid', value: 'v' }];
    fill({
      service: 'github',
      profile: 'work',
      url: 'https://github.com/login',
    });

    state().restore();
    expect(workerBodies.some((body) => body['op'] === 'setcookies')).toBeFalse();
    durable['load'].next({ payload: jar });

    expect(bodyFor(workerBodies, 'setcookies')['cookies']).toBe(jar);
  });

  it('unwraps a jar the platform stored before it was flattened', () => {
    // A wrapper is what `cookies` hands out, and a jar stored by an earlier build
    // that did not unwrap is still a jar. Restoring one must not 400.
    const jar = [{ name: 'sid', value: 'v' }];
    fill({
      service: 'github',
      profile: 'work',
      url: 'https://github.com/login',
    });

    state().restore();
    durable['load'].next({ payload: { count: 1, cookies: jar } });

    expect(bodyFor(workerBodies, 'setcookies')['cookies']).toBe(jar);
  });

  it('refuses to push back an entry that holds no cookies', () => {
    fill({
      service: 'github',
      profile: 'work',
      url: 'https://github.com/login',
    });

    state().restore();
    durable['load'].next({ payload: { status: 'ok', count: 0, cookies: [] } });

    // `setcookies` would have said "cookies array required", which describes our
    // request rather than the state of the entry.
    expect(state().failure()).toBe('VAULT.EMPTY_ENTRY');
    expect(workerBodies.some((body) => body['op'] === 'setcookies')).toBeFalse();
  });

  it('needs the login page before it can put a jar back', () => {
    fill({ service: 'github', profile: 'work', url: '' });

    state().restore();

    // Cookies belong to an origin, so the browser has to be on the site first --
    // and the check happens before the read, so nothing is even fetched.
    expect(state().failure()).toBe('VAULT.NEEDS_URL');
    expect(durableBodies.some((body) => body['op'] === 'load')).toBeFalse();
  });

  it('forgets the entry it was given, by name', () => {
    state().forget({ service: 'github', profile: 'work' });

    expect(bodyFor(durableBodies, 'forget')).toEqual({
      op: 'forget',
      service: 'github',
      profile: 'work',
    });
  });

  it('tells a 403 on the cookie pair apart from one on an entry op', () => {
    // Same status, two different problems: the cookie pair is refused until the
    // caller names their own browser, and the entry ops are refused until a
    // caller has a worker of their own. One message for both would send someone
    // who forgot one field to support.
    fill({ service: 'github', profile: 'work' });
    state().keep();
    worker['cookies'].error(new HttpErrorResponse({ status: 403 }));
    expect(state().failure()).toBe('VAULT.NEEDS_OWN_BROWSER');

    state().save();
    worker['save_state'].error(new HttpErrorResponse({ status: 403 }));
    expect(state().failure()).toBe('VAULT.NO_PRIVATE_WORKER');
  });

  it('names each account-store refusal as its own remedy', () => {
    // 409 is the entry cap, 404 is an entry that is gone, and 503 is a
    // deployment with no vault key. None of the three is "try again".
    durable['list'].error(new HttpErrorResponse({ status: 503 }));
    expect(state().failure()).toBe('VAULT.UNAVAILABLE');

    fill({ service: 'github', profile: 'work' });
    state().keep();
    worker['cookies'].next({
      status: 'ok',
      data: {
        status: 'ok',
        count: 1,
        cookies: [{ name: 'sid', value: 'v' }],
      },
    });
    durable['store'].error(new HttpErrorResponse({ status: 409 }));
    expect(state().failure()).toBe('VAULT.CAP');

    fill({ url: 'https://github.com/login' });
    state().restore();
    durable['load'].error(new HttpErrorResponse({ status: 404 }));
    expect(state().failure()).toBe('VAULT.GONE');
  });
});
