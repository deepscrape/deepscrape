import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { Observable, Subject } from 'rxjs';
import {
  AdminSession,
  AdminSessionResponse,
  AdminSessionsService,
} from '../../core/services/admin-sessions.service';
import { AdminSessionsComponent } from './admin-sessions.component';

/**
 * One session, with the fields the page reads.
 * @param {Partial<AdminSession>} patch Fields to override.
 * @return {AdminSession} The session.
 */
const session = (patch: Partial<AdminSession> = {}): AdminSession => ({
  uid: 'u1',
  id: 's1',
  mode: 'dedicated',
  kind: 'chrome',
  state: 'ready',
  tier: 'paid',
  createdAt: 0,
  lastUsedAt: 0,
  minutesBilled: 0,
  ...patch,
});

/**
 * What is worth pinning here is not that a table renders but the decisions a
 * reader would otherwise have to trust: that a failed read is an ERROR and never
 * an empty list, that 403 is a permission boundary rather than an outage, and
 * that an unusable last-used stamp reads as UNKNOWN instead of as "just used".
 *
 * The idle-time cases carry the most weight. A live-session console exists to
 * answer "what is stuck", and every way of computing that age has a way of
 * quietly lying: bad arithmetic says a busy session is idle, and clock skew says
 * a session is minus three minutes old.
 */
describe('AdminSessionsComponent', () => {
  let fixture: ComponentFixture<AdminSessionsComponent>;
  let list$: Subject<AdminSessionResponse>;

  /** A response with a status but no body, which is what the guard reads. */
  const httpError = (status: number): HttpErrorResponse =>
    new HttpErrorResponse({ status });

  beforeEach(async () => {
    list$ = new Subject();

    const stub = {
      list: (): Observable<AdminSessionResponse> => list$.asObservable(),
    };

    await TestBed.configureTestingModule({
      imports: [AdminSessionsComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AdminSessionsService, useValue: stub },
        // The envelope this page wraps renders through the animation engine, so
        // without this EVERY render throws NG05105.
        provideNoopAnimations(),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminSessionsComponent);
    // ngOnInit issues the read, so this is also what puts `list$` under
    // observation.
    fixture.detectChanges();
  });

  const page = (): AdminSessionsComponent => fixture.componentInstance;

  /**
   * Answer the pending read.
   * @param {AdminSession[]} sessions The sessions to answer with.
   * @param {boolean} truncated Whether the server capped the read.
   * @return {void} Nothing.
   */
  const replies = (sessions: AdminSession[], truncated = false): void => {
    list$.next({ status: 'ok', sessions, truncated });
    list$.complete();
    fixture.detectChanges();
  };

  it('shows ready when sessions come back', () => {
    replies([session(), session({ id: 's2' })]);
    expect(page().state()).toBe('ready');
    expect(page().sessions().length).toBe(2);
  });

  it('shows empty, not ready, when nothing is live', () => {
    replies([]);
    expect(page().state()).toBe('empty');
  });

  it('reports an unreadable list as an error, never as an empty one', () => {
    // "Nobody is running a browser" and "the index behind this query is missing"
    // produce the same empty table, and the remedies are opposite. Reporting the
    // second as the first tells an operator the platform is idle while customers
    // are being billed for sessions they cannot see.
    list$.error(httpError(500));
    expect(page().state()).toBe('error');
    expect(page().errorKey()).toBe('ADMIN_SESSIONS.ERROR_GENERIC');
  });

  it('keeps 403 a permission boundary, not an outage', () => {
    list$.error(httpError(403));
    expect(page().errorKey()).toBe('ADMIN_SESSIONS.ERROR_PERMISSION');
    expect(page().errorKey()).not.toBe('ADMIN_SESSIONS.ERROR_GENERIC');
  });

  it('sums the minutes billed across the loaded page', () => {
    replies([
      session({ minutesBilled: 20 }),
      session({ id: 's2', minutesBilled: 5 }),
    ]);
    expect(page().billedMinutes()).toBe(25);
  });

  it('carries the truncation flag through, so a capped page never reads as all', () => {
    replies([session()], true);
    expect(page().truncated()).toBeTrue();
  });

  it('reports an unusable last-used stamp as unknown, not as zero idle', () => {
    // A session used a second ago and a session whose stamp did not parse look
    // identical to an operator hunting for something stuck, so they must not be
    // rendered the same.
    replies([session({ lastUsedAt: 0 })]);
    expect(page().rows()[0].idleMinutes).toBeNull();
  });

  it('clamps a future stamp to zero rather than rendering a negative age', () => {
    // Clock skew between the server that wrote the stamp and this browser must
    // not produce "-3 minutes idle".
    replies([session({ lastUsedAt: Date.now() + 60_000 })]);
    expect(page().rows()[0].idleMinutes).toBe(0);
  });

  it('measures idle time in whole minutes', () => {
    replies([session({ lastUsedAt: Date.now() - 5 * 60_000 - 1_000 })]);
    expect(page().rows()[0].idleMinutes).toBe(5);
  });
});
