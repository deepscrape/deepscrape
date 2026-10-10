import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { Observable, Subject } from 'rxjs';
import { BrowserSessionService } from '../../services/browser-session.service';
import {
  BrowserSession,
  BrowserSessionCreateRequest,
  BrowserSessionListResponse,
  BrowserSessionResponse,
} from '../../types/browser-session.interface';
import { BrowserSessionPanelComponent } from './browser-session-panel.component';

/**
 * One session, with the fields the panel reads.
 * @param {Partial<BrowserSession>} patch Fields to override.
 * @return {BrowserSession} The session.
 */
const session = (patch: Partial<BrowserSession> = {}): BrowserSession => ({
  id: 's1',
  mode: 'dedicated',
  kind: 'chrome',
  state: 'ready',
  createdAt: 0,
  ...patch,
});

/**
 * What is worth pinning here is not that the panel renders but the decisions it
 * makes that a reader would otherwise have to trust: which status is a plan
 * boundary and which is a permission one, that a BYO endpoint is sent only for
 * BYO, and that a failed ACTION never hides the list.
 *
 * This spec is also what forces the component's TEMPLATE to compile. Nothing
 * imports the panel yet, so the production build can drop it without ever parsing
 * its template.
 */
describe('BrowserSessionPanelComponent', () => {
  let fixture: ComponentFixture<BrowserSessionPanelComponent>;
  let list$: Subject<BrowserSessionListResponse>;
  let create$: Subject<BrowserSessionResponse>;
  let keepalive$: Subject<BrowserSessionResponse>;
  let close$: Subject<BrowserSessionResponse>;
  let created: BrowserSessionCreateRequest[];
  let closeCalls: number;

  /** A response with a status but no body, which is what the guard reads. */
  const httpError = (status: number): HttpErrorResponse =>
    new HttpErrorResponse({ status });

  beforeEach(async () => {
    list$ = new Subject();
    create$ = new Subject();
    keepalive$ = new Subject();
    close$ = new Subject();
    created = [];
    closeCalls = 0;

    const stub = {
      list: (): Observable<BrowserSessionListResponse> => list$.asObservable(),
      create: (
        request: BrowserSessionCreateRequest
      ): Observable<BrowserSessionResponse> => {
        created.push(request);
        return create$.asObservable();
      },
      keepalive: (): Observable<BrowserSessionResponse> =>
        keepalive$.asObservable(),
      close: (): Observable<BrowserSessionResponse> => {
        closeCalls++;
        return close$.asObservable();
      },
      // Only the specs that OPEN a live view reach this, because the frame is
      // mounted on demand. It is here so those specs exercise the panel rather
      // than a frame component that fell over on a missing method.
      frameUrl: (id: string, nonce: number): string =>
        `/api/browser/session/${id}/frame?n=${nonce}`,
    };

    await TestBed.configureTestingModule({
      // `forRoot()` rather than a `TranslateService` stub: these tests render, and
      // the pipe reaches into the store `forRoot()` installs. With nothing loaded
      // ngx-translate answers with the key itself, which is what is asserted.
      imports: [BrowserSessionPanelComponent, TranslateModule.forRoot()],
      providers: [
        { provide: BrowserSessionService, useValue: stub },
        // The template binds `@listStagger`, so the renderer needs an animation
        // engine or EVERY render throws NG05105. The app supplies
        // `provideAnimationsAsync()` in `app.config.ts`; `Noop` is the test
        // equivalent, so these specs assert behaviour rather than timing.
        provideNoopAnimations(),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(BrowserSessionPanelComponent);
    // ngOnInit issues the list call, so this is also what puts `list$` under
    // observation.
    fixture.detectChanges();
  });

  const panel = (): BrowserSessionPanelComponent => fixture.componentInstance;

  /**
   * Answer the pending list call.
   * @param {BrowserSession[]} sessions The sessions to answer with.
   * @return {void} Nothing.
   */
  const listReplies = (sessions: BrowserSession[]): void => {
    list$.next({ status: 'ok', sessions });
    list$.complete();
    fixture.detectChanges();
  };

  it('shows ready when sessions come back', () => {
    listReplies([session(), session({ id: 's2' })]);
    expect(panel().state()).toBe('ready');
    expect(panel().sessions().length).toBe(2);
  });

  it('shows empty, not ready, when nothing is leased', () => {
    // "Nothing is leased" and "here is your list" have different remedies.
    listReplies([]);
    expect(panel().state()).toBe('empty');
  });

  it('reads 402 as a plan boundary', () => {
    list$.error(httpError(402));
    expect(panel().errorKey()).toBe('BROWSER_SESSION.ERROR_PLAN');
    expect(panel().state()).toBe('error');
  });

  it('keeps 403 a permission boundary, not a plan one', () => {
    // A viewer with no lease rights is not a customer who has not paid, so the
    // two axes must not collapse into one message.
    list$.error(httpError(403));
    expect(panel().errorKey()).toBe('BROWSER_SESSION.ERROR_PERMISSION');
    expect(panel().errorKey()).not.toBe('BROWSER_SESSION.ERROR_PLAN');
  });

  it('reads 503 as capacity', () => {
    list$.error(httpError(503));
    expect(panel().errorKey()).toBe('BROWSER_SESSION.ERROR_CAPACITY');
  });

  it('requires an endpoint before a bring-your-own session', () => {
    panel().setMode('byo');
    expect(panel().canCreate()).toBeFalse();
    panel().cdpControl.setValue('wss://example.test/cdp');
    expect(panel().canCreate()).toBeTrue();
  });

  it('allows a dedicated session with no endpoint', () => {
    expect(panel().canCreate()).toBeTrue();
    expect(panel().create).toBeDefined();
    panel().create();
    expect(created.length).toBe(1);
    expect(created[0].mode).toBe('dedicated');
  });

  it('sends the endpoint for a bring-your-own session', () => {
    panel().setMode('byo');
    panel().cdpControl.setValue('wss://example.test/cdp');
    panel().create();
    expect(created[0].mode).toBe('byo');
    expect(created[0].cdpUrl).toBe('wss://example.test/cdp');
  });

  it('sends no endpoint for a dedicated session', () => {
    // A URL left over from BYO must not ride along on a dedicated create.
    panel().setMode('byo');
    panel().cdpControl.setValue('wss://example.test/cdp');
    panel().setMode('dedicated');
    panel().create();
    expect(created[0].cdpUrl).toBeUndefined();
  });

  it('clears a stale endpoint when switching back to dedicated', () => {
    panel().setMode('byo');
    panel().cdpControl.setValue('wss://example.test/cdp');
    panel().setMode('dedicated');
    expect(panel().cdpControl.value).toBe('');
  });

  it('drops a closed session from the list', () => {
    // The server's own list excludes `closed`, so a finished session must leave
    // here too or the page disagrees with itself on the next reload.
    listReplies([session({ id: 's1' }), session({ id: 's2' })]);
    panel().close('s1');
    close$.next({ status: 'ok', session: session({ id: 's1', state: 'closed' }) });
    close$.complete();
    expect(panel().sessions().map(item => item.id)).toEqual(['s2']);
  });

  it('falls back to empty when the last session closes', () => {
    listReplies([session({ id: 's1' })]);
    panel().close('s1');
    close$.next({ status: 'ok', session: session({ id: 's1', state: 'closed' }) });
    close$.complete();
    expect(panel().state()).toBe('empty');
  });

  it('reports a failed keepalive WITHOUT hiding the list', () => {
    // The session that needs acting on is in the list, so a failed action must
    // not flip the envelope to `error` and take the row off screen.
    listReplies([session({ id: 's1' })]);
    panel().keepalive('s1');
    keepalive$.error(httpError(502));
    expect(panel().noticeKey()).toBe('BROWSER_SESSION.KEEPALIVE_FAILED');
    expect(panel().state()).toBe('ready');
    expect(panel().sessions().length).toBe(1);
  });

  it('reports a failed close and keeps the session on screen', () => {
    // The server leaves a session OPEN when its final charge fails, so it is
    // still live and still billing, and the row must stay put.
    listReplies([session({ id: 's1' })]);
    panel().close('s1');
    close$.error(httpError(502));
    expect(panel().noticeKey()).toBe('BROWSER_SESSION.CLOSE_FAILED');
    expect(panel().sessions().length).toBe(1);
    expect(panel().state()).toBe('ready');
  });

  it('keeps row busy state independent', () => {
    listReplies([session({ id: 's1' }), session({ id: 's2' })]);
    panel().close('s1');
    expect(panel().action('s1')).toBe('closing');
    expect(panel().action('s2')).toBe('none');
  });

  it('ignores a second press on a row already working', () => {
    // A close is a billed event, so the button is single-fire while in flight.
    listReplies([session({ id: 's1' })]);
    panel().close('s1');
    panel().close('s1');
    expect(closeCalls).toBe(1);
  });

  it('renders the state as text, so colour is never the only signal', () => {
    listReplies([session({ id: 's1', state: 'ready' })]);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('BROWSER_SESSION.STATE_READY');
  });

  /** The live view element, or null when no row has one mounted. */
  const frameElement = (): Element | null =>
    (fixture.nativeElement as HTMLElement).querySelector('app-browser-frame');

  it('offers a live view where the engine renders a page', () => {
    expect(panel().canFrame('chrome')).toBeTrue();
    expect(panel().canFrame('obscura')).toBeTrue();
  });

  it('refuses a live view for the engine that renders nothing', () => {
    // Lightpanda returns markup with no layout and no paint, which is exactly why
    // it is cheap. There are no pixels, so a frame would be an image that cannot
    // exist and the row would be permanently broken instead of explanatory.
    expect(panel().canFrame('lightpanda')).toBeFalse();
  });

  it('mounts no live view until one is asked for', () => {
    // The default matters: an unrequested frame polls a machine nobody is
    // watching, and a dedicated session bills for that.
    listReplies([session({ id: 's1', kind: 'chrome' })]);
    expect(panel().isFramed('s1')).toBeFalse();
    expect(frameElement()).toBeNull();
  });

  it('mounts the live view when it is opened', () => {
    listReplies([session({ id: 's1', kind: 'chrome' })]);
    panel().toggleFrame('s1');
    fixture.detectChanges();
    expect(frameElement()).not.toBeNull();
  });

  it('unmounts the live view rather than hiding it when closed', () => {
    // The frame owns the poll and the poll is what bills, so "closed" has to mean
    // destroyed. A frame parked behind CSS would keep asking a live machine for
    // pictures nobody can see.
    listReplies([session({ id: 's1', kind: 'chrome' })]);
    panel().toggleFrame('s1');
    fixture.detectChanges();
    expect(frameElement()).not.toBeNull();

    panel().toggleFrame('s1');
    fixture.detectChanges();
    expect(frameElement()).toBeNull();
  });

  it('opens one row without opening the others', () => {
    listReplies([session({ id: 's1' }), session({ id: 's2' })]);
    panel().toggleFrame('s2');
    expect(panel().isFramed('s2')).toBeTrue();
    expect(panel().isFramed('s1')).toBeFalse();
  });

  it('forgets a row live view when the session ends', () => {
    // Otherwise the flag map outgrows the list it describes.
    listReplies([session({ id: 's1' })]);
    panel().toggleFrame('s1');
    panel().close('s1');
    close$.next({ status: 'ok', session: session({ id: 's1', state: 'closed' }) });
    close$.complete();
    expect(panel().isFramed('s1')).toBeFalse();
  });
});
