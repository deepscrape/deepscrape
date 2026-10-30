import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, throwError } from 'rxjs';

import { DashboardComponent } from './dashboard.component';
import { getTestProviders } from 'src/app/testing';
import {
  BillingService,
  DeploymentService,
  OrganizationService,
} from 'src/app/core/services';
import { BrowserSessionService } from 'src/app/core/services/browser-session.service';
import { NotificationCenterService } from 'src/app/core/services/notification-center.service';

const billing = {
  plan: 'pro',
  status: 'active',
  subscriptionId: 'sub_1',
  graceUntil: null,
  credits: { balance: 4200, reserved: 30 },
  features: {},
};

describe('DashboardComponent', () => {
  let component: DashboardComponent;
  let fixture: ComponentFixture<DashboardComponent>;
  let sessions: Partial<BrowserSessionService>;
  let machines: Partial<DeploymentService>;

  const build = async () => {
    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        ...getTestProviders(),
        { provide: BillingService, useValue: { billing$: of(billing) } },
        { provide: BrowserSessionService, useValue: sessions },
        { provide: DeploymentService, useValue: machines },
        { provide: NotificationCenterService, useValue: { unread: () => 3 } },
        {
          provide: OrganizationService,
          useValue: {
            listMyOrganizations: () => of({ organizations: [{ id: 'org_1' }] }),
            listMembers: () => of({ members: [{ id: 'a' }, { id: 'b' }] }),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ orgId: 'org_1' })) },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    return fixture;
  };

  beforeEach(() => {
    sessions = { list: () => of({ status: 'ok' as never, sessions: [{ id: 's1' }, { id: 's2' }] as never }) };
    machines = {
      listMine: () =>
        of({
          status: 'ok' as const,
          machines: [
            { id: 'm1', state: 'started' },
            { id: 'm2', state: 'suspended' },
          ] as never,
        }),
    };
  });

  it('should create', async () => {
    await build();
    expect(component).toBeTruthy();
  });

  it('should apply grow class via host binding', async () => {
    const host: HTMLElement = (await build()).nativeElement;
    expect(host.classList.contains('grow')).toBeTrue();
  });

  it('does NOT mount the neko viewer', async () => {
    // Pinned in the NEGATIVE on purpose. `app-browser` was mounted here and
    // reached a fixed external WebRTC host on every dashboard visit, so this
    // assertion is what stops it quietly creeping back in.
    const browserHost = (await build()).nativeElement.querySelector('app-browser');
    expect(browserHost).toBeNull();
  });

  it('counts open sessions and the machines that are actually started', async () => {
    await build();
    expect(component.liveSessions()).toBe(2);
    expect(component.machineTotals()).toEqual({ total: 2, running: 1 });
  });

  it('keeps the page up when the session count fails', async () => {
    sessions = { list: () => throwError(() => new Error('503')) };
    await build();
    // A failed count renders an em dash, never a 0 that reads as "nothing running".
    expect(component.liveSessions()).toBeNull();
  });
});
