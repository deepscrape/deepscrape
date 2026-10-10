import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { StorageTabComponent } from './storage.component';
import { BucketStorageService } from 'src/app/core/services';
import { getTestProviders } from 'src/app/testing';

/**
 * The Storage settings tab.
 *
 * The class doc calls the credential rule "the credential rule, in one place",
 * so these specs pin THAT rather than the template: a blank secret must be
 * omitted (so "leave it blank" means "keep what is stored"), a typed secret must
 * be cleared from the control after a successful save, and kept after a failed
 * one so a retry does not force a second paste.
 *
 * It is also the only spec this component has, which matters for a second
 * reason: a component with no spec is compiled by Karma only if something else
 * imports it, so before this file `bun run build` was the only gate that ever
 * parsed its template.
 */
describe('StorageTabComponent', () => {
  let component: StorageTabComponent;
  let storageMock: jasmine.SpyObj<BucketStorageService>;

  /** Reach a `protected` member without weakening the component's own API. */
  const internals = () => component as any;

  const settings = (mode: 'platform' | 'byob' = 'platform', hasCredentials = false) => ({
    mode,
    hasCredentials,
  });

  beforeEach(() => {
    storageMock = jasmine.createSpyObj('BucketStorageService', [
      'getSettings',
      'saveSettings',
    ]);
    storageMock.getSettings.and.returnValue(of(settings()));
    storageMock.saveSettings.and.returnValue(of(settings('byob', true)));

    TestBed.configureTestingModule({
      providers: [
        ...getTestProviders(),
        { provide: BucketStorageService, useValue: storageMock },
      ],
    });

    component = TestBed.runInInjectionContext(() => new StorageTabComponent());
    component.ngOnInit();
  });

  it('should be created', () => {
    expect(component).toBeTruthy();
  });

  it('should read settings on init and keep only the credentials BOOLEAN', () => {
    expect(storageMock.getSettings).toHaveBeenCalled();

    // The server answers with `hasCredentials: boolean`, never the key material,
    // so the boolean is the only thing the component may hold.
    expect(internals().hasCredentials()).toBe(false);
    expect(internals().loading()).toBe(false);
    expect(internals().accessKeyControl.value).toBe('');
    expect(internals().secretKeyControl.value).toBe('');
  });

  it('should render an error state when the settings read fails', () => {
    storageMock.getSettings.and.returnValue(throwError(() => new Error('nope')));

    const fresh = TestBed.runInInjectionContext(() => new StorageTabComponent());
    fresh.ngOnInit();

    expect((fresh as any).loading()).toBe(false);
    expect((fresh as any).statusTone()).toBe('error');
    expect((fresh as any).statusKey()).toBe('STORAGE.ERR_LOAD');
  });

  it('should omit a blank secret so the stored value is kept', () => {
    internals().modeControl.setValue({ name: 'byob', code: 'byob' });
    internals().bucketControl.setValue('my-bucket', { emitEvent: false });

    internals().saveSettings();

    const request = storageMock.saveSettings.calls.mostRecent().args[0];
    expect(request.mode).toBe('byob');
    expect(request.bucket).toBe('my-bucket');
    // Omitted, NOT sent as an empty string — that is what "leaving it blank keeps
    // the stored value" means on the wire.
    expect('accessKey' in request).toBe(false);
    expect('secretKey' in request).toBe(false);
  });

  it('should send typed credentials and then clear the controls', () => {
    internals().modeControl.setValue({ name: 'byob', code: 'byob' });
    internals().accessKeyControl.setValue('AKIA-example', { emitEvent: false });
    internals().secretKeyControl.setValue('secret-example', { emitEvent: false });

    internals().saveSettings();

    const request = storageMock.saveSettings.calls.mostRecent().args[0];
    expect(request.accessKey).toBe('AKIA-example');
    expect(request.secretKey).toBe('secret-example');

    // Cleared on success so the value does not sit in a live control.
    expect(internals().accessKeyControl.value).toBe('');
    expect(internals().secretKeyControl.value).toBe('');
    expect(internals().hasCredentials()).toBe(true);
    expect(internals().statusKey()).toBe('STORAGE.SAVED_SETTINGS');
  });

  it('should keep typed credentials when the save fails', () => {
    storageMock.saveSettings.and.returnValue(throwError(() => new Error('boom')));
    internals().modeControl.setValue({ name: 'byob', code: 'byob' });
    internals().accessKeyControl.setValue('AKIA-example', { emitEvent: false });
    internals().secretKeyControl.setValue('secret-example', { emitEvent: false });

    internals().saveSettings();

    // Kept on failure, so a retry does not force the customer to paste again.
    expect(internals().accessKeyControl.value).toBe('AKIA-example');
    expect(internals().secretKeyControl.value).toBe('secret-example');
    expect(internals().statusTone()).toBe('error');
    expect(internals().saving()).toBe(false);
  });

  it('should clear credentials by switching back to the platform mode', () => {
    // A successful clear answers `hasCredentials: false` — the component mirrors
    // the server's reply rather than assuming the write worked.
    storageMock.saveSettings.and.returnValue(of(settings('platform', false)));
    internals().hasCredentials.set(true);

    internals().clearCredentials();

    // "Clear" and "use the platform bucket" are the same state: a BYOB mode with
    // no credential is a bucket nothing can sign against.
    expect(storageMock.saveSettings).toHaveBeenCalledWith({ mode: 'platform' });
    expect(internals().hasCredentials()).toBe(false);
    expect(internals().statusKey()).toBe('STORAGE.CLEAR_DONE');
  });

  it('should not clear when there is nothing stored', () => {
    internals().hasCredentials.set(false);

    internals().clearCredentials();

    expect(storageMock.saveSettings).not.toHaveBeenCalled();
  });

  it('should ignore a second save while one is in flight', () => {
    internals().saving.set(true);

    internals().saveSettings();

    expect(storageMock.saveSettings).not.toHaveBeenCalled();
  });
});
