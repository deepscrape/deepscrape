import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ExtractStrategyComponent } from './extract-strategy.component';
import { getTestProviders } from 'src/app/testing';

describe('ExtractStrategyComponent', () => {
  let component: ExtractStrategyComponent;
  let fixture: ComponentFixture<ExtractStrategyComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ExtractStrategyComponent],
      providers: getTestProviders(),
    })
    .compileComponents();

    fixture = TestBed.createComponent(ExtractStrategyComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should render the compiler form', () => {
    // Translation-independent on purpose: the labels come from the i18n bundle,
    // so asserting on copy would fail whenever the bundle is not loaded.
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement | null;

    expect(form).not.toBeNull();
  });

  it('should compile as standalone component', () => {
    expect((ExtractStrategyComponent as any).ɵcmp.standalone).toBeTrue();
  });
});
