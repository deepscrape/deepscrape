import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AccountSettingsComponent } from './account.component';
import { AuthzService } from 'src/app/core/services';
import { getTestProviders } from 'src/app/testing';

describe('AccountSettingsComponent', () => {
  let component: AccountSettingsComponent;
  let fixture: ComponentFixture<AccountSettingsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AccountSettingsComponent],
      providers: getTestProviders(),
    })
    .compileComponents();

    fixture = TestBed.createComponent(AccountSettingsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('routerLink should carry the active org onto every tab', () => {
    // The tabs used to emit absolute paths, which dropped the org: the guard then had
    // to re-derive it with an API call on every click, and that call answered 401 while
    // the bearer token was still settling.
    expect(component.routerLink('account')).toBe('/settings');
    expect(component.routerLink('security')).toBe('/settings/security');

    TestBed.inject(AuthzService).setActiveOrgId('acme');

    expect(component.routerLink('account')).toBe('/acme/settings');
    expect(component.routerLink('security')).toBe('/acme/settings/security');
  });

  it('getAnimationData should read animation key from outlet data', () => {
    const outlet = {
      activatedRouteData: { animation: 'settings-slide' },
    } as any;

    expect(component.getAnimationData(outlet)).toBe('settings-slide');
  });

  it('ngOnDestroy should unsubscribe router subscription', () => {
    const unsubscribeSpy = jasmine.createSpy('unsubscribe');
    (component as any).routeSub = { unsubscribe: unsubscribeSpy };

    component.ngOnDestroy();

    expect(unsubscribeSpy).toHaveBeenCalled();
  });
});
