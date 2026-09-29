import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { AppSidebarComponent } from './app-sidebar.component';
import { getTestProviders } from 'src/app/testing';
import { LoadingService } from 'src/app/core/services';

describe('AppSidebarComponent', () => {
  let component: AppSidebarComponent;
  let fixture: ComponentFixture<AppSidebarComponent>;
  let loadingSubject: BehaviorSubject<boolean>;
  let loadingServiceMock: jasmine.SpyObj<LoadingService> & { loadingSubject$: BehaviorSubject<boolean> };

  beforeEach(async () => {
    loadingSubject = new BehaviorSubject<boolean>(false);
    loadingServiceMock = jasmine.createSpyObj('LoadingService', ['startLoading', 'stopLoading']) as any;
    loadingServiceMock.loadingSubject$ = loadingSubject;

    await TestBed.configureTestingModule({
      imports: [AppSidebarComponent],
      providers: [...getTestProviders(), { provide: LoadingService, useValue: loadingServiceMock }],
    })
    .compileComponents();

    fixture = TestBed.createComponent(AppSidebarComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should update loading state from LoadingService stream', () => {
    loadingSubject.next(true);
    expect(component.isLoading()).toBe(true);

    loadingSubject.next(false);
    expect(component.isLoading()).toBe(false);
  });

  it('should emit backdrop event on sidebar close', () => {
    const emitSpy = spyOn(component.backDropPressed, 'emit');

    component.onSidebarClose(true);

    expect(emitSpy).toHaveBeenCalledWith(true);
  });

  it('should emit backdrop event only when blur target is clicked', () => {
    const emitSpy = spyOn(component.backDropPressed, 'emit');

    component.backDropClicked({ target: { id: 'asidebarblur' } } as any);
    expect(emitSpy).toHaveBeenCalledWith(true);

    emitSpy.calls.reset();
    component.backDropClicked({ target: { id: 'other' } } as any);
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
