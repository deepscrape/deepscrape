import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CookieConsentComponent } from './cookie-consent.component';
import { getTestProviders } from 'src/app/testing';

/**
 * The banner is the gate. A visitor who has not answered must not be able to use the page
 * behind it, and Esc must not be an unrecorded exit — an unrecorded exit leaves no answer,
 * which is the state the whole consent mechanism exists to avoid.
 */
describe('CookieConsentComponent', () => {
  let fixture: ComponentFixture<CookieConsentComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CookieConsentComponent],
      providers: getTestProviders(),
    }).compileComponents();

    fixture = TestBed.createComponent(CookieConsentComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  const dialog = (): HTMLDialogElement | null => fixture.nativeElement.querySelector('dialog');

  it('opens as a modal, which is what makes the page behind it inert', () => {
    expect(dialog()?.open).toBeTrue();
  });

  it('swallows Esc instead of closing without a recorded answer', () => {
    const cancel = new Event('cancel', { cancelable: true });

    dialog()?.dispatchEvent(cancel);

    expect(cancel.defaultPrevented).toBeTrue();
  });

  it('names the cookies each category owns once expanded', () => {
    (fixture.componentInstance as unknown as { expanded: { set(value: boolean): void } })
      .expanded.set(true);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('gid');
    expect(text).toContain('device_id');
  });
});
