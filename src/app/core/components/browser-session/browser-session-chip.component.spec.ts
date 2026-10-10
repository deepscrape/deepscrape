import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { BrowserSessionChipComponent } from './browser-session-chip.component';
import { BrowserSession } from '../../types/browser-session.interface';

/**
 * One session, with the fields this component reads.
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
 * The chip is presentational, so what is worth pinning is not that it renders
 * but that the three things it derives are derived correctly: the translation
 * KEY, the class list, and the fact that the state reaches the DOM as text.
 *
 * This spec is also what forces the component's TEMPLATE to be compiled at all.
 * Nothing imports the chip yet, so the production build can drop it without ever
 * parsing its template. The same trap is already documented for Karma, which
 * only compiles components a spec imports; the difference here is that an
 * unreferenced component escapes `bun run build` too.
 */
describe('BrowserSessionChipComponent', () => {
  let fixture: ComponentFixture<BrowserSessionChipComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      // `forRoot()` rather than a `TranslateService` stub, which is what
      // `tools-panel`'s spec uses. That spec only ever reads the component
      // INSTANCE and never renders, so its stub never has to satisfy the pipe.
      // These tests do render, and the pipe reaches into the store `forRoot()`
      // installs. With no translations loaded ngx-translate answers with the key
      // itself, which is exactly what these assertions expect.
      imports: [BrowserSessionChipComponent, TranslateModule.forRoot()],
    }).compileComponents();

    fixture = TestBed.createComponent(BrowserSessionChipComponent);
  });

  /**
   * Point the chip at a session.
   * @param {Partial<BrowserSession>} patch Fields to override.
   * @return {void} Nothing.
   */
  const render = (patch: Partial<BrowserSession> = {}): void => {
    fixture.componentRef.setInput('session', session(patch));
  };

  it('builds the state key from the server value, not a local switch', () => {
    render({ state: 'suspended' });
    expect(fixture.componentInstance.stateKey())
      .toBe('BROWSER_SESSION.STATE_SUSPENDED');
  });

  it('builds the mode key from the server value', () => {
    render({ mode: 'byo' });
    expect(fixture.componentInstance.modeKey())
      .toBe('BROWSER_SESSION.MODE_BYO');
  });

  it('stays out of the namespace the remote-browser viewer owns', () => {
    // `BROWSER` already belongs to the viewer, whose strings describe a
    // connection. A session key landing there would read as the wrong feature,
    // and the two would be impossible to separate by name alone.
    render({ state: 'ready', mode: 'dedicated' });
    expect(fixture.componentInstance.stateKey().startsWith('BROWSER_SESSION.'))
      .toBeTrue();
    expect(fixture.componentInstance.modeKey().startsWith('BROWSER_SESSION.'))
      .toBeTrue();
  });

  it('gives all four states a distinct class list', () => {
    // The failure this catches: a copy-paste leaving two states looking
    // identical, which removes the one thing a status chip is for.
    const seen = new Set<string>();
    for (const state of ['starting', 'ready', 'suspended', 'closed'] as const) {
      render({ state });
      seen.add(fixture.componentInstance.chipClass());
    }
    expect(seen.size).toBe(4);
  });

  it('keeps the shared chip classes whatever the state', () => {
    render({ state: 'closed' });
    expect(fixture.componentInstance.chipClass()).toContain('rounded-full');
  });

  it('renders the state as TEXT, so colour is never the only signal', () => {
    render({ state: 'ready' });
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('BROWSER_SESSION.STATE_READY');
  });

  it('renders the mode as text too', () => {
    render({ mode: 'byo' });
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('BROWSER_SESSION.MODE_BYO');
  });

  it('marks the decorative dot as hidden from assistive tech', () => {
    render();
    fixture.detectChanges();
    const dot = (fixture.nativeElement as HTMLElement)
      .querySelector('[aria-hidden="true"]');
    expect(dot).not.toBeNull();
  });
});
