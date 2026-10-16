import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { of } from 'rxjs';
import { BrowserSessionService } from '../../services/browser-session.service';
import { BrowserFrameComponent, pageFields, toolPayload } from './browser-frame.component';

/**
 * A `tools/call` answer wrapped around a tool payload.
 *
 * The payload really does travel as a STRING inside the envelope -- that is the
 * shape `toolPayload` exists to undo -- so these cases build the shape the machine
 * actually sends rather than a convenient approximation of it.
 * @param {unknown} payload The tool's own JSON.
 * @return {unknown} The envelope.
 */
const envelope = (payload: unknown): unknown => ({
  result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
});

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

  /**
   * Every interaction the component sent, in order.
   *
   * Not reset between cases: each spec reads the LAST entry, the same way the
   * frame-URL cases read `urls`. Resetting would make the array's LENGTH the
   * assertion, which is a different claim from "what was actually sent".
   */
  const calls: { name: string; args: Record<string, unknown> }[] = [];

  /**
   * What the next `tool()` call answers with, as the MCP envelope.
   *
   * A variable rather than a fixed value because the typing cases need a real
   * payload inside the envelope while every other case wants the empty one.
   */
  let toolResult: unknown = {};

  /** When true, the next `tool()` call is refused the way a 4xx would be. */
  let toolFails = false;

  const stub = {
    frameUrl: (sessionId: string, nonce: number): string => {
      urls.push({ sessionId, nonce });
      return `/api/browser/session/${sessionId}/frame?n=${nonce}`;
    },
    tool: (
      _sessionId: string,
      name: string,
      args: Record<string, unknown>,
    ): unknown => {
      calls.push({ name, args });

      if (toolFails) {
        throw new Error('refused');
      }

      return of({ tool: name, result: toolResult });
    },
  };

  beforeEach(async () => {
    urls.length = 0;
    toolResult = {};
    toolFails = false;

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

  /**
   * Size the picture the way a real page would.
   *
   * `naturalWidth` is a prototype getter, so it has to be shadowed on the INSTANCE;
   * the real endpoint does not exist in the spec environment, so without this the
   * image reports 0 and `clickFrame` correctly refuses to guess. `clientWidth` is
   * never used by the mapping, which is the point: the display ratio comes from the
   * rendered box, not from an attribute the CSS can contradict.
   */
  const sizeImage = (natural: [number, number], box: [number, number]) => {
    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: natural[0] });
    Object.defineProperty(img, 'naturalHeight', { value: natural[1] });
    img.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: box[0], height: box[1] }) as DOMRect;
    return img;
  };

  it('maps a click through the picture display scale', async () => {
    // A 1280x720 screenshot shown in a 640x360 box: every displayed pixel is TWO
    // page pixels. A click at the centre of the box must therefore land at
    // (640, 360) on the page rather than (320, 180) -- and the offsets, not the raw
    // client coordinates, are what gets scaled.
    sizeImage([1280, 720], [640, 360]);

    await frame().clickFrame(new MouseEvent('click', { clientX: 330, clientY: 200 }));

    const sent = calls[calls.length - 1];
    expect(sent.name).toBe('webrain_interact');
    expect(sent.args).toEqual({ action: 'click_coords', x: 640, y: 360 });
  });

  it('scales each axis by its own ratio', async () => {
    // A box that is NOT proportional is the case a single ratio gets wrong, and it
    // is the case a rounded container creates. Both axes are doubled here, but by
    // ratios derived separately, so an implementation sharing one would fail.
    sizeImage([800, 600], [400, 600]);

    await frame().clickFrame(new MouseEvent('click', { clientX: 210, clientY: 320 }));

    const sent = calls[calls.length - 1];
    // x: (210 - 10) * (800/400) = 400   y: (320 - 20) * (600/600) = 300
    expect(sent.args).toEqual({ action: 'click_coords', x: 400, y: 300 });
  });

  it('sends no interaction while the view is paused', async () => {
    // A paused picture is not the current page, so a click mapped against it would
    // land at coordinates nobody chose -- and the caller would have no way to tell.
    sizeImage([1280, 720], [1280, 720]);
    frame().toggle();
    const before = calls.length;

    await frame().clickFrame(new MouseEvent('click', { clientX: 5, clientY: 5 }));

    expect(calls.length).toBe(before);
  });

  it('sends no interaction once a frame has failed', async () => {
    sizeImage([1280, 720], [1280, 720]);
    frame().onFrameError();
    const before = calls.length;

    await frame().clickFrame(new MouseEvent('click', { clientX: 5, clientY: 5 }));

    expect(calls.length).toBe(before);
  });

  it('reads the element list, then types by the engine index', async () => {
    // The index the engine reports is what `type` resolves against, so an element
    // at array position 0 carrying index 7 must type into 7 -- not into 0.
    toolResult = envelope({
      status: 'ok',
      elements: [
        { index: 7, tag: 'input', text: 'Email', visible: true },
        { index: 9, tag: 'input', text: 'Hidden', visible: false },
      ],
    });

    await frame().loadFields();

    expect(calls[calls.length - 1]).toEqual({
      name: 'webrain_observe',
      args: { what: 'state' },
    });
    expect(frame().fields()).toEqual([{ index: 7, label: 'input \u2014 Email' }]);
    expect(frame().fieldControl.value).toBe(7);

    frame().textControl.setValue('hello');
    await frame().typeText();

    expect(calls[calls.length - 1]).toEqual({
      name: 'webrain_interact',
      args: { action: 'type', index: 7, text: 'hello' },
    });
  });

  it('types only when there is both an element and text', async () => {
    // The engine refuses a missing index but types an empty string without
    // complaint, so the guard must cover both or the empty case is a silent no-op
    // that looks like a success on a picture that has not changed.
    toolResult = envelope({
      status: 'ok',
      elements: [{ index: 2, tag: 'input', text: 'Go', visible: true }],
    });
    await frame().loadFields();
    const afterLoad = calls.length;

    frame().fieldControl.setValue(null);
    frame().textControl.setValue('x');
    await frame().typeText();
    expect(calls.length).toBe(afterLoad);

    frame().fieldControl.setValue(2);
    frame().textControl.setValue('');
    await frame().typeText();
    expect(calls.length).toBe(afterLoad);
    expect(frame().actionNote()).toBe('BROWSER_SESSION.TYPE_NEEDS_BOTH');
  });

  it('keeps the text when the engine refused, and clears it when it did not', async () => {
    // What was typed may be a credential, so it is cleared only on success -- but a
    // REFUSED send must keep it, or the user retypes it for nothing.
    frame().fieldControl.setValue(1);
    frame().textControl.setValue('secret');
    toolFails = true;

    await frame().typeText();

    expect(frame().actionNote()).toBe('BROWSER_SESSION.ACTION_FAILED');
    expect(frame().textControl.value).toBe('secret');

    toolFails = false;
    await frame().typeText();

    expect(frame().actionNote()).toBe('BROWSER_SESSION.ACTION_SENT');
    expect(frame().textControl.value).toBe('');
  });
});

describe('tool payload unwrapping', () => {
  it('reads the tool JSON out of the text part', () => {
    const payload = { status: 'ok', elements: [{ index: 1 }] };
    expect(toolPayload(envelope(payload))).toEqual(payload);
  });

  it('returns nothing rather than half an object for a shape it does not know', () => {
    // Each of these is a contract that can drift, and a caller must be able to tell
    // "no answer" from "an empty answer" -- an empty object would read as a page
    // with nothing interactive instead of as a reply that did not parse.
    expect(toolPayload(undefined)).toBeUndefined();
    expect(toolPayload({})).toBeUndefined();
    expect(toolPayload({ result: { content: 'nope' } })).toBeUndefined();
    expect(toolPayload({ result: { content: [{ type: 'text' }] } })).toBeUndefined();
    expect(
      toolPayload({ result: { content: [{ type: 'text', text: 'not json' }] } }),
    ).toBeUndefined();
  });

  it('joins a payload split across parts', () => {
    const split = { result: { content: [{ text: '{"a":' }, { text: '1}' }] } };
    expect(toolPayload(split)).toEqual({ a: 1 });
  });
});

describe('page field extraction', () => {
  it('keeps the engine index, not the array position', () => {
    const rows = pageFields({
      elements: [{ index: 7, tag: 'input', text: 'Email', visible: true }],
    });

    expect(rows).toEqual([{ index: 7, label: 'input \u2014 Email' }]);
  });

  it('drops invisible rows and rows with no numeric index', () => {
    const rows = pageFields({
      elements: [
        { index: 1, tag: 'a', text: 'One', visible: true },
        { index: 2, tag: 'a', text: 'Two', visible: false },
        { index: '3', tag: 'a', text: 'Three', visible: true },
        { tag: 'a', text: 'Four', visible: true },
      ],
    });

    expect(rows).toEqual([{ index: 1, label: 'a \u2014 One' }]);
  });

  it('falls back to the tag when the element has no text', () => {
    const rows = pageFields({
      elements: [{ index: 4, tag: 'button', text: '', visible: true }],
    });

    expect(rows).toEqual([{ index: 4, label: 'button' }]);
  });

  it('reports no rows for a payload it cannot read', () => {
    expect(pageFields(undefined)).toEqual([]);
    expect(pageFields({})).toEqual([]);
    expect(pageFields({ elements: 'nope' })).toEqual([]);
  });
});
