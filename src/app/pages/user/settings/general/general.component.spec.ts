import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GeneralTabComponent } from './general.component';
import { getTestProviders } from 'src/app/testing';

describe('GeneralTabComponent', () => {
  let component: GeneralTabComponent;
  let fixture: ComponentFixture<GeneralTabComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GeneralTabComponent],
      providers: getTestProviders(),
    })
    .compileComponents();

    fixture = TestBed.createComponent(GeneralTabComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should render the section headings', () => {
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('SETTINGS_GENERAL.TITLE');
    expect(text).toContain('SETTINGS_GENERAL.APPEARANCE');
    expect(text).toContain('SETTINGS_GENERAL.LANGUAGE');
    expect(text).toContain('SETTINGS_GENERAL.RECEIVE_NOTIFICATIONS');
  });

  it('should offer no save button, because every setting applies immediately', () => {
    // The theme toggle, language picker and push toggle all commit on change, so
    // there is nothing to submit. The previous assertion asked for a
    // `button[type="submit"]` reading COMMON.SAVE, which matched a design this
    // page no longer has.
    const button = fixture.nativeElement.querySelector('button[type="submit"]');

    expect(button).toBeNull();
  });
});
