import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DashboardComponent } from './dashboard.component';
import { getTestProviders } from 'src/app/testing';

describe('DashboardComponent', () => {
  let component: DashboardComponent;
  let fixture: ComponentFixture<DashboardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: getTestProviders(),
    })
    .compileComponents();

    fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should apply grow class via host binding', () => {
    const host: HTMLElement = fixture.nativeElement;

    expect(host.classList.contains('grow')).toBeTrue();
  });

  it('does NOT mount the neko viewer', () => {
    // Pinned in the NEGATIVE on purpose. `app-browser` was mounted here and
    // reached a fixed external WebRTC host on every dashboard visit, so this
    // assertion is what stops it quietly creeping back in.
    const browserHost = fixture.nativeElement.querySelector('app-browser');

    expect(browserHost).toBeNull();
  });

  it('fetchData should execute without throwing', () => {
    expect(() => component.fetchData()).not.toThrow();
  });
});
