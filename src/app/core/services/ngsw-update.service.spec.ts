import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';

import { NgswUpdateService } from './ngsw-update.service';
import { SwUpdate } from '@angular/service-worker';

import { getTestProviders } from 'src/app/testing';

describe('NgswUpdateService', () => {
  let service: NgswUpdateService;
  let swUpdateMock: {
    isEnabled: boolean;
    versionUpdates: Subject<any>;
    activateUpdate: jasmine.Spy;
  };
  let documentMock: { location: { reload: jasmine.Spy }; visibilityState: string };

  beforeEach(() => {
    swUpdateMock = {
      isEnabled: false,
      versionUpdates: new Subject<any>(),
      activateUpdate: jasmine.createSpy('activateUpdate').and.returnValue(Promise.resolve(true)),
    };
    documentMock = {
      location: { reload: jasmine.createSpy('reload') },
      visibilityState: 'hidden',
    };

    TestBed.configureTestingModule({
      providers: [
        ...getTestProviders(),
        { provide: SwUpdate, useValue: swUpdateMock },
        { provide: DOCUMENT, useValue: documentMock }
      ]
    });
    service = new NgswUpdateService(TestBed.inject(SwUpdate), TestBed.inject(DOCUMENT));
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should activate and reload on VERSION_READY when enabled', async () => {
    swUpdateMock.isEnabled = true;
    service = new NgswUpdateService(TestBed.inject(SwUpdate), TestBed.inject(DOCUMENT));

    swUpdateMock.versionUpdates.next({ type: 'VERSION_READY' });
    await Promise.resolve();

    expect(swUpdateMock.activateUpdate).toHaveBeenCalled();
    expect(documentMock.location.reload).toHaveBeenCalled();
  });

  it('activates without reloading while the user is looking at the page', async () => {
    // The defect this guards: a deploy by someone else reloaded the page in
    // front of a user mid-checkout, destroying what they had typed.
    documentMock.visibilityState = 'visible';
    swUpdateMock.isEnabled = true;
    service = new NgswUpdateService(TestBed.inject(SwUpdate), TestBed.inject(DOCUMENT));

    swUpdateMock.versionUpdates.next({ type: 'VERSION_READY' });
    await Promise.resolve();

    expect(swUpdateMock.activateUpdate).toHaveBeenCalled();
    expect(documentMock.location.reload).not.toHaveBeenCalled();
  });

  it('should not activate update when service worker updates are disabled', () => {
    swUpdateMock.isEnabled = false;
    service = new NgswUpdateService(TestBed.inject(SwUpdate), TestBed.inject(DOCUMENT));

    swUpdateMock.versionUpdates.next({ type: 'VERSION_READY' });

    expect(swUpdateMock.activateUpdate).not.toHaveBeenCalled();
  });
});
