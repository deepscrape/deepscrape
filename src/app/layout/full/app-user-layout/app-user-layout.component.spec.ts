import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AppUserLayoutComponent } from './app-user-layout.component';
import { getTestProviders } from 'src/app/testing';

describe('AppUserLayoutComponent', () => {
  let component: AppUserLayoutComponent;
  let fixture: ComponentFixture<AppUserLayoutComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppUserLayoutComponent],
      providers: getTestProviders(),
    })
    .compileComponents();

    fixture = TestBed.createComponent(AppUserLayoutComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('renders the workspace and pending invitations from the signals', () => {
    component.user.set({
      uid: 'user-a',
      providerId: 'password',
      displayName: 'User A',
      email: 'a@example.com',
    } as any);
    component.showProfileMenu.set(true);
    component.organizations.set([{ id: 'acme', name: 'Acme' } as any]);
    component.workspaceDropdownOptions.set([{ code: 'acme', name: 'Acme (owner)' }]);
    component.invitations.set([{ id: 'inv-1', orgId: 'globex', role: 'member' } as any]);

    fixture.detectChanges();

    // The workspace branch replaces the empty state, and the invitation row interpolates.
    // Both fail if the template stops calling the signals.
    expect(fixture.nativeElement.querySelector('app-dropdown')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('globex');
  });

  it('openProfileMenu should open directly for user photo target', () => {
    component.showProfileMenu.set(false);

    component.openProfileMenu({ target: { alt: 'user photo' } });

    expect(component.showProfileMenu()).toBeTrue();
  });

  it('openProfileMenu should toggle menu for non-photo trigger', () => {
    component.showProfileMenu.set(false);

    component.openProfileMenu();
    expect(component.showProfileMenu()).toBeTrue();

    component.openProfileMenu();
    expect(component.showProfileMenu()).toBeFalse();
  });

  it('onCloseAsideBar should update state and show scrollbar when closed', () => {
    const showScrollSpy = spyOn((component as any).scrollService, 'showScroll');

    component.onCloseAsideBar(true);

    expect(component.closeAsideBar()).toBeTrue();
    expect(showScrollSpy).toHaveBeenCalled();
  });

  it('closeProfileMenu navigates to the org-scoped page for the selected action', () => {
    const navigateSpy = spyOn((component as any).router, 'navigateByUrl');
    component.selectedOrgId.set('acme');
    const event = {
      target: {
        getAttribute: () => 'billing'
      }
    } as unknown as Event;

    component.closeProfileMenu(event, 'user-a');

    expect(component.showProfileMenu()).toBeFalse();
    expect(navigateSpy).toHaveBeenCalledWith('/acme/billing');
  });

  it('switchOrganization moves the url onto the new org', () => {
    const navigate = jasmine.createSpy('navigateByUrl');
    const swap = (url: string, from: string | null, to: string) => {
      (component as any).router = { url, navigateByUrl: navigate };
      component.selectedOrgId.set(from);
      component.switchOrganization(to);
      return navigate.calls.mostRecent()?.args[0];
    };

    // Canonical url: the old org segment is replaced.
    expect(swap('/acme/billing', 'acme', 'globex')).toBe('/globex/billing');
    // Legacy bare url: the page path is kept and prefixed.
    expect(swap('/billing/plans', null, 'globex')).toBe('/globex/billing/plans');
    // Console surface is not org-scoped, so the url is left alone.
    navigate.calls.reset();
    swap('/admin/users', null, 'globex');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ngOnDestroy should unsubscribe known subscriptions', () => {
    const logoutSubscription = jasmine.createSpyObj('Subscription', ['unsubscribe']);
    const orgLoadSubscription = jasmine.createSpyObj('Subscription', ['unsubscribe']);
    const invitationLoadSubscription = jasmine.createSpyObj('Subscription', ['unsubscribe']);
    const invitationActionSubscription = jasmine.createSpyObj('Subscription', ['unsubscribe']);
    const sizeSub = jasmine.createSpyObj('Subscription', ['unsubscribe']);
    const routerEventSubscription = jasmine.createSpyObj('Subscription', ['unsubscribe']);

    component.logoutSubscription = logoutSubscription;
    component.orgLoadSubscription = orgLoadSubscription;
    component.invitationLoadSubscription = invitationLoadSubscription;
    component.invitationActionSubscription = invitationActionSubscription;
    component.sizeSub = sizeSub;
    (component as any).routerEventSubscription = routerEventSubscription;

    component.ngOnDestroy();

    expect(logoutSubscription.unsubscribe).toHaveBeenCalled();
    expect(orgLoadSubscription.unsubscribe).toHaveBeenCalled();
    expect(invitationLoadSubscription.unsubscribe).toHaveBeenCalled();
    expect(invitationActionSubscription.unsubscribe).toHaveBeenCalled();
    expect(sizeSub.unsubscribe).toHaveBeenCalled();
    expect(routerEventSubscription.unsubscribe).toHaveBeenCalled();
  });
});
