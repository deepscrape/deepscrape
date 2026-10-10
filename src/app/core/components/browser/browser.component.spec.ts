import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { BrowserComponent } from './browser.component';
import { AuthService, WebRtcService, WindowToken } from '../../services';
import { getTestProviders } from 'src/app/testing';

describe('BrowserComponent', () => {
  let component: BrowserComponent;

  const windowStub = {
    getSelection: jasmine.createSpy('getSelection').and.returnValue({ toString: () => 'copied text' }),
  } as unknown as Window;

  const rtcStub = {
    connect: jasmine.createSpy('connect').and.resolveTo(),
    close: jasmine.createSpy('close'),
    sendClipboardText: jasmine.createSpy('sendClipboardText'),
    sendData: jasmine.createSpy('sendData'),
    connectionStatus$: of(false),
    track$: of(),
    clipboard$: of(''),
    controlStatus$: of(false),
  } as unknown as WebRtcService;

  const authStub = {} as AuthService;

  const documentStub = {
    addEventListener: jasmine.createSpy('addEventListener'),
    removeEventListener: jasmine.createSpy('removeEventListener'),
    exitFullscreen: jasmine.createSpy('exitFullscreen').and.resolveTo(),
  } as unknown as Document;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ...getTestProviders(),
        { provide: WindowToken, useValue: windowStub },
      ],
    });

    (rtcStub.connect as jasmine.Spy).calls.reset();
    (rtcStub.close as jasmine.Spy).calls.reset();
    (rtcStub.sendClipboardText as jasmine.Spy).calls.reset();
    (documentStub.addEventListener as jasmine.Spy).calls.reset();
    (documentStub.removeEventListener as jasmine.Spy).calls.reset();
    (documentStub.exitFullscreen as jasmine.Spy).calls.reset();
    Object.defineProperty(documentStub, 'fullscreenElement', { value: null, writable: true, configurable: true });

    component = TestBed.runInInjectionContext(
      () => new BrowserComponent(rtcStub, authStub, documentStub)
    );

    // The viewer takes its signalling endpoint from the CALLER now, not from a
    // build constant (`environment.nekoUrl`, removed 2026-10-10), so a spec that
    // exercises `startStream` has to supply one.
    component.endpoint = 'wss://neko.example.test';
  });

  it('should start a stream, clear existing tracks, and focus the overlay', async () => {
    const stopTrackSpy = jasmine.createSpy('stop');
    const focusSpy = jasmine.createSpy('focus');
    const mediaStreamStub = {
      getTracks: () => [{ stop: stopTrackSpy }],
    } as unknown as MediaStream;

    component.videoRef = {
      nativeElement: {
        srcObject: mediaStreamStub,
      },
    } as BrowserComponent['videoRef'];
    component.overlayRef = {
      nativeElement: {
        focus: focusSpy,
      },
    } as unknown as BrowserComponent['overlayRef'];

    await component.startStream();

    expect(rtcStub.connect).toHaveBeenCalled();
    expect(stopTrackSpy).toHaveBeenCalled();
    expect(component.videoRef.nativeElement.srcObject).toBeNull();
    expect(focusSpy).toHaveBeenCalled();
    expect(component.connecting).toBeFalse();
  });

  it('refuses to connect when no endpoint was supplied', async () => {
    // The removal's whole point: with no caller-supplied endpoint there is no
    // fixed host left to fall back to, so nothing is dialled. `videoRef` is
    // stubbed for exactly the reason the spec above stubs it -- so the ONLY
    // difference between the two cases is the endpoint itself.
    component.endpoint = '';
    component.videoRef = {
      nativeElement: { srcObject: null },
    } as BrowserComponent['videoRef'];

    await component.startStream();

    expect(rtcStub.connect).not.toHaveBeenCalled();
    // Names the endpoint, so this cannot pass on an earlier TypeError instead.
    expect(component.error).toContain('endpoint');
  });

  it('should expose clipboard and resolution controls through child components', () => {
    const clipboardOpenSpy = jasmine.createSpy('openClipboard');
    const resolutionOpenSpy = jasmine.createSpy('openResolution');
    component.clipboardRef = { open: clipboardOpenSpy } as unknown as BrowserComponent['clipboardRef'];
    component.resolutionRef = { open: resolutionOpenSpy } as unknown as BrowserComponent['resolutionRef'];

    component.openClipboard();
    component.openResolution();

    expect(clipboardOpenSpy).toHaveBeenCalled();
    expect(resolutionOpenSpy).toHaveBeenCalled();
  });

  it('should send clipboard text to the rtc service', () => {
    component.onClipboardSent('hello remote');

    expect(rtcStub.sendClipboardText).toHaveBeenCalledWith('hello remote');
  });

  it('should update local control state', () => {
    component.onControlChanged(true);
    expect(component.hasControl).toBeTrue();

    component.onControlChanged(false);
    expect(component.hasControl).toBeFalse();
  });

  it('should toggle fullscreen based on current document state', async () => {
    const requestFullscreenSpy = jasmine.createSpy('requestFullscreen').and.resolveTo();
    const parentElement = { requestFullscreen: requestFullscreenSpy } as unknown as HTMLElement;
    component.videoRef = {
      nativeElement: {
        parentElement,
      },
    } as BrowserComponent['videoRef'];

    component.requestFullscreen();
    expect(requestFullscreenSpy).toHaveBeenCalled();

    Object.defineProperty(documentStub, 'fullscreenElement', { value: {} as Element, writable: true, configurable: true });
    component.requestFullscreen();
    expect(documentStub.exitFullscreen).toHaveBeenCalled();
  });

  it('should close the rtc connection on destroy', () => {
    component.ngOnDestroy();
    expect(rtcStub.close).toHaveBeenCalled();
  });
});
