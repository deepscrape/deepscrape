import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { ClipboardbuttonComponent } from './clipboardbutton.component';
import { getTestProviders } from 'src/app/testing';

describe('ClipboardbuttonComponent', () => {
  let component: ClipboardbuttonComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: getTestProviders() });
    TestBed.runInInjectionContext(() => {
      component = new ClipboardbuttonComponent();
    });
  });

  it('onClick immediately sets title to the copied key', () => {
    component.onClick();
    expect((component as any).title()).toBe('CLIPBOARD.COPIED');
  });

  it('onClick resets title to the copy-code key after 800 ms', fakeAsync(() => {
    component.onClick();
    tick(800);
    expect((component as any).title()).toBe('CLIPBOARD.COPY_CODE');
  }));

  it('starts with title copy-code key', () => {
    expect((component as any).title()).toBe('CLIPBOARD.COPY_CODE');
  });
});
