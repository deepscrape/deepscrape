import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { of } from 'rxjs';

import { AppSidebarNavComponent } from './app-sidebar-nav.component';
import { getTestProviders } from 'src/app/testing';
import { AuthService, LoadingService } from 'src/app/core/services';

describe('AppSidebarNavComponent', () => {
  let component: AppSidebarNavComponent;
  let fixture: ComponentFixture<AppSidebarNavComponent>;
  let loadingServiceMock: jasmine.SpyObj<LoadingService>;
  let authServiceMock: jasmine.SpyObj<AuthService>;

  beforeEach(async () => {
    loadingServiceMock = jasmine.createSpyObj('LoadingService', ['startLoading', 'stopLoading']);
    authServiceMock = jasmine.createSpyObj('AuthService', [], { isAdmin: false, user$: of(null) });

    await TestBed.configureTestingModule({
      imports: [AppSidebarNavComponent],
      providers: [
        ...getTestProviders(),
        { provide: LoadingService, useValue: loadingServiceMock },
        { provide: AuthService, useValue: authServiceMock },
      ],
    })
    .compileComponents();

    fixture = TestBed.createComponent(AppSidebarNavComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should start loading in constructor and stop after view init delay', fakeAsync(() => {
    expect(loadingServiceMock.startLoading).toHaveBeenCalled();

    component.ngAfterViewInit();
    tick(401);

    expect(loadingServiceMock.stopLoading).toHaveBeenCalled();
  }));

  // The app origin no longer carries the admin tree — it lives in `adminNavigation`
  // for the console origin. The only admin-gated item here is the single 'Console'
  // cross-link, which is what `filteredNavigation` actually filters on.
  it('should hide the Console cross-link when user is not admin', () => {
    Object.defineProperty(authServiceMock, 'isAdmin', { value: false, configurable: true });

    const fx = TestBed.createComponent(AppSidebarNavComponent);
    const comp = fx.componentInstance;
    fx.detectChanges();

    const hasConsole = (comp as any).filteredNavigation.some((item: any) => item?.name === 'Console');
    expect(hasConsole).toBe(false);
  });

  it('should show the Console cross-link when user is admin', () => {
    Object.defineProperty(authServiceMock, 'isAdmin', { value: true, configurable: true });

    const fx = TestBed.createComponent(AppSidebarNavComponent);
    const comp = fx.componentInstance;
    fx.detectChanges();

    const hasConsole = (comp as any).filteredNavigation.some((item: any) => item?.name === 'Console');
    expect(hasConsole).toBe(true);
  });

  it('should identify divider and title items correctly', () => {
    expect(component.isDivider({ divider: true })).toBe(true);
    expect(component.isDivider({})).toBe(false);
    expect(component.isTitle({ title: true })).toBe(true);
    expect(component.isTitle({})).toBe(false);
  });
});
