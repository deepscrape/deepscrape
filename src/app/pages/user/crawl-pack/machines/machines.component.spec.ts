import { TestBed } from '@angular/core/testing';
import { MachinesComponent } from './machines.component';
import { ReactiveFormsModule } from '@angular/forms';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { getTestProviders } from 'src/app/testing';
import { LocalStorage } from 'src/app/core/services';
import { of } from 'rxjs';
import { MineMachine } from 'src/app/core/types/machine-fleet.interface';

describe('MachinesComponent', () => {
  let component: MachinesComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [
        MachinesComponent,
        ReactiveFormsModule,
        BrowserAnimationsModule,
        MatIconModule,
        MatProgressSpinnerModule,
      ],
      providers: [
        ...getTestProviders(),
        {
          provide: LocalStorage,
          useValue: {
            getItem: (key: string) => null,
            setItem: (key: string, value: string) => { },
            removeItem: (key: string) => { },
          },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(MachinesComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create the component', () => {
    expect(component).toBeTruthy();
  });

  it('should check if theme is dark', () => {
    spyOn(component['localStorage'], 'getItem').and.returnValue('true');
    expect(component.themeIsDark()).toBe(true);
  });

  /**
   * A machine the component has not been told about is a plain container.
   *
   * This is the deliberate failure direction: an unannotated row is actionable,
   * which is at worst the behaviour before the guard existed. Failing the other
   * way would refuse a legitimate container action because one read timed out.
   */
  it('should treat a machine it was not told about as a plain container', () => {
    expect(component['isSessionMachine']('never-seen')).toBe(false);
  });

  it('should mark a machine session-owned only when a session backs it', () => {
    spyOn(component['deployService'], 'listMine').and.returnValue(of({
      status: 'ok' as const,
      machines: [
        machine({ id: 'bs-1', kind: 'browser-session', sessionId: 'sess-1' }),
        machine({ id: 'bs-2', kind: 'browser-session' }),
        machine({ id: 'crawl-1' }),
      ],
    }));

    component['loadMachineKinds']();

    expect(component['isSessionMachine']('bs-1')).toBe(true);
    // A session row carrying no session id has no panel entry to hand the user,
    // so calling it session-owned would refuse an action and offer nothing back.
    expect(component['isSessionMachine']('bs-2')).toBe(false);
    expect(component['isSessionMachine']('crawl-1')).toBe(false);
  });

  it('should refuse an action on a session-owned machine and say why', () => {
    component['sessionMachineIds'].set({ 'bs-1': 'sess-1' });
    const snackbar = spyOn(component, 'showSnackbar');

    expect(component['refuseSessionOwnedAction']('bs-1')).toBe(true);
    expect(snackbar).toHaveBeenCalled();

    snackbar.calls.reset();

    expect(component['refuseSessionOwnedAction']('crawl-1')).toBe(false);
    expect(snackbar).not.toHaveBeenCalled();
  });

  it('should never reach the destroy endpoint for a session-owned machine', () => {
    component['sessionMachineIds'].set({ 'bs-1': 'sess-1' });
    const destroy = spyOn(component['deployService'], 'destroy');

    component['destroyMachine']({
      id: 'bs-1',
      laststate: 'started',
      instance_id: 'instance-1',
    });

    // The point of the guard: the request is never sent, so a session record
    // cannot be left billing for a machine that no longer exists.
    expect(destroy).not.toHaveBeenCalled();
  });
});

/**
 * One machine, with only the fields a test cares about spelled out.
 * @param {Partial<MineMachine>} over The fields to override.
 * @return {MineMachine} A machine to feed the list.
 */
const machine = (over: Partial<MineMachine>): MineMachine => ({
  id: 'machine',
  name: 'machine',
  state: 'started',
  region: 'fra',
  createdAt: '2026-10-04T00:00:00Z',
  updatedAt: '2026-10-04T00:00:00Z',
  kind: 'container',
  ...over,
});