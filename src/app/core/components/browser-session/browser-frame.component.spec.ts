import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { BrowserSessionService } from '../../services/browser-session.service';
import { BrowserFrameComponent } from './browser-frame.component';

/**
 * What is worth pinning here is the behaviour that costs money if it is wrong: that
 * the loop actually stops when the component is destroyed, that a hidden tab asks
 * for nothing, and that a failure is a state the surface can state rather than a
 * frozen image that looks live.
 *
 * The frame endpoint itself does not exist yet (roadmap `03` Part A), so nothing
 * here asserts an image arrives. The URL CONTRACT is asserted instead, because that
 * is the half Part A has to honour.
 */
describe('BrowserFrameComponent', () => {
  let fixture: ComponentFixture<BrowserFrameComponent>;
  const urls: { sessionId: string; nonce: number }[] = [];

  const stub = {
    frameUrl: (sessionId: string, nonce: number): string => {
      urls.push({ sessionId, nonce });
      return `/api/browser/session/${sessionId}/frame?n=${nonce}`;
    },
  };

  beforeEach(async () => {
    urls.length = 0;

    await TestBed.configureTestingModule({
      imports: [BrowserFrameComponent, TranslateModule.forRoot()],
      providers: [{ provide: BrowserSessionService, useValue: stub }],
    }).compileComponents();

    fixture = TestBed.createComponent(BrowserFrameComponent);
    fixture.componentRef.setInput('sessionId', 's1');
    // Model a VISIBLE tab. Headless Chrome reports `document.visibilityState` as
    // `hidden`, and the component is right not to poll then -- so without this every
    // poll case below would silently be asserting the paused path instead.
    fixture.componentInstance.hidden.set(false);
    fixture.detectChanges();
  });

  const frame = (): BrowserFrameComponent => fixture.componentInstance;

  it('asks the service for the frame URL, per session', () => {
    // The contract with Part A: `/api/browser/session/:id/frame`.
    frame().poll();
    expect(urls[urls.length - 1].sessionId).toBe('s1');
  });

  it('changes the URL on every poll, so nothing caches a frame', () => {
    // A cached frame of someone's live session is worse than no frame: it looks live.
    const first = frame().frameUrl();
    frame().poll();
    expect(frame().frameUrl()).not.toBe(first);
  });

  it('stops polling when paused', () => {
    frame().toggle();
    const before = frame().frameUrl();
    frame().poll();
    expect(frame().frameUrl()).toBe(before);
  });

  it('asks for a frame immediately on resume', () => {
    frame().toggle();
    const paused = frame().frameUrl();
    frame().toggle();
    expect(frame().frameUrl()).not.toBe(paused);
  });

  it('reports a failure as a status, not as a frozen image', () => {
    frame().onFrameError();
    expect(frame().failed()).toBeTrue();
    expect(frame().statusKey()).toBe('BROWSER_SESSION.FRAME_FAILED');
    expect(frame().statusKey()).not.toBe('BROWSER_SESSION.FRAME_LIVE');
  });

  it('lets a failure outrank a pause, because the remedies differ', () => {
    frame().toggle();
    frame().onFrameError();
    expect(frame().statusKey()).toBe('BROWSER_SESSION.FRAME_FAILED');
  });

  it('clears the failure when a frame arrives', () => {
    frame().onFrameError();
    frame().onFrameLoad();
    expect(frame().failed()).toBeFalse();
    expect(frame().statusKey()).toBe('BROWSER_SESSION.FRAME_LIVE');
  });

  it('shows the toggle as the action, not the state', () => {
    expect(frame().toggleKey()).toBe('BROWSER_SESSION.FRAME_PAUSE');
    frame().toggle();
    expect(frame().toggleKey()).toBe('BROWSER_SESSION.FRAME_RESUME');
  });

  it('asks for nothing while the tab is hidden', () => {
    // The money rule: frames nobody can see are still frames the customer pays for.
    frame().hidden.set(true);
    const before = frame().frameUrl();
    frame().poll();
    expect(frame().frameUrl()).toBe(before);
  });

  it('resumes once the tab is visible again', () => {
    frame().hidden.set(true);
    const hidden = frame().frameUrl();
    frame().hidden.set(false);
    frame().poll();
    expect(frame().frameUrl()).not.toBe(hidden);
  });

  it('stops the loop on destroy', () => {
    // B.8 asks for exactly this assertion. A leaked interval keeps capturing frames
    // and keeps billing minutes with nothing on screen.
    expect(frame().polling).not.toBeNull();
    fixture.destroy();
    expect(frame().polling).toBeNull();
  });
});
