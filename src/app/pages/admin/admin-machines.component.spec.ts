import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { Observable, Subject } from 'rxjs';
import { MachineFleetService } from '../../core/services/machine-fleet.service';
import {
  FleetMachine,
  MachineFleetResponse,
} from '../../core/types/machine-fleet.interface';
import { AdminMachinesComponent } from './admin-machines.component';

/**
 * One machine, with the fields the page reads.
 * @param {Partial<FleetMachine>} patch Fields to override.
 * @return {FleetMachine} The machine.
 */
const machine = (patch: Partial<FleetMachine> = {}): FleetMachine => ({
  id: '3d8d3f9e11112222',
  uid: 'aaaaaaaa-bbbb-cccc-dddd',
  name: 'bs-s1',
  state: 'started',
  region: 'iad',
  createdAt: '2026-10-03T10:00:00Z',
  updatedAt: '',
  ...patch,
});

/**
 * What is worth pinning here is not that a table renders but the four decisions a
 * reader would otherwise have to trust: that a capped read says so, that 403 and
 * 401 are different failures, that a running count counts, and that a timestamp
 * the server sent but the browser cannot parse is shown rather than replaced by
 * `Invalid Date`.
 *
 * This spec is also what forces the TEMPLATE to compile in the test build. The
 * page IS referenced by `admin.route.ts`, so `bun run build` covers it too; both
 * gates are run regardless.
 */
describe('AdminMachinesComponent', () => {
  let fixture: ComponentFixture<AdminMachinesComponent>;
  let list$: Subject<MachineFleetResponse>;

  /** A response with a status but no body, which is what the guard reads. */
  const httpError = (status: number): HttpErrorResponse =>
    new HttpErrorResponse({ status });

  beforeEach(async () => {
    list$ = new Subject();

    const stub = {
      list: (): Observable<MachineFleetResponse> => list$.asObservable(),
    };

    await TestBed.configureTestingModule({
      imports: [AdminMachinesComponent, TranslateModule.forRoot()],
      providers: [
        { provide: MachineFleetService, useValue: stub },
        // The envelope this page wraps renders through the animation engine, so
        // without this EVERY render throws NG05105. Same reason the browser
        // session panel spec needs it.
        provideNoopAnimations(),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminMachinesComponent);
    // ngOnInit issues the list call, so this is also what puts `list$` under
    // observation.
    fixture.detectChanges();
  });

  const page = (): AdminMachinesComponent => fixture.componentInstance;

  /**
   * Answer the pending list call.
   * @param {FleetMachine[]} machines The machines to answer with.
   * @param {boolean} truncated Whether the server capped the read.
   * @return {void} Nothing.
   */
  const listReplies = (
    machines: FleetMachine[],
    truncated = false
  ): void => {
    list$.next({ status: 'ok', machines, truncated });
    list$.complete();
    fixture.detectChanges();
  };

  it('shows ready when machines come back', () => {
    listReplies([machine(), machine({ id: 'other' })]);
    expect(page().state()).toBe('ready');
    expect(page().machines().length).toBe(2);
  });

  it('shows empty, not ready, when no machine is leased', () => {
    // "Nothing is leased" and "here is your list" have different remedies.
    listReplies([]);
    expect(page().state()).toBe('empty');
  });

  it('says so when the read was capped', () => {
    // A silent cap is how an operator concludes a machine is gone when it is
    // merely past the limit.
    listReplies([machine()], true);
    expect(page().truncated()).toBeTrue();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ADMIN_MACHINES.TRUNCATED');
  });

  it('does not claim a cap when there was none', () => {
    listReplies([machine()], false);
    expect(page().truncated()).toBeFalse();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('ADMIN_MACHINES.TRUNCATED');
  });

  it('keeps 403 a permission boundary', () => {
    // A non-admin is not an expired session, and the two need different remedies:
    // one is "ask for access", the other is "sign in again".
    list$.error(httpError(403));
    expect(page().errorKey()).toBe('ADMIN_MACHINES.ERROR_PERMISSION');
    expect(page().state()).toBe('error');
  });

  it('treats 401 as an expired session, not a permission problem', () => {
    list$.error(httpError(401));
    expect(page().errorKey()).toBe('ADMIN_MACHINES.ERROR_SESSION');
    expect(page().errorKey()).not.toBe('ADMIN_MACHINES.ERROR_PERMISSION');
  });

  it('reports an unreadable fleet as a failure, not as an empty one', () => {
    // The likeliest cause is the undeployed collection-group index, and an empty
    // list would hide it behind "you have no machines".
    list$.error(httpError(500));
    expect(page().errorKey()).toBe('ADMIN_MACHINES.ERROR_GENERIC');
    expect(page().state()).not.toBe('empty');
  });

  it('counts only the machines that are up', () => {
    listReplies([
      machine({ id: 'a', state: 'started' }),
      machine({ id: 'b', state: 'starting' }),
      machine({ id: 'c', state: 'stopped' }),
      machine({ id: 'd', state: 'suspended' }),
    ]);
    expect(page().running()).toBe(2);
  });

  it('shortens an id to the prefix an operator matches on', () => {
    expect(page().shortId('3d8d3f9e11112222')).toBe('3d8d3f9e');
    expect(page().shortId('abc')).toBe('abc');
  });

  it('styles a running machine distinctly', () => {
    expect(page().stateClass('started')).toContain('cyan');
  });

  it('does not break on a state it has never seen', () => {
    // Fly adds states, and nothing enforces that this list agrees with theirs. An
    // unrecognised state must render, not throw.
    const classes = page().stateClass('some-future-state');
    expect(classes).toContain('rounded-full');
    expect(classes).not.toContain('cyan');
  });

  it('shows a timestamp the browser cannot parse instead of Invalid Date', () => {
    // Arachnefly stores `created_at` as a string. When the value is real but
    // unparseable, showing the server's own words beats showing a placeholder
    // that teaches an operator to ignore the column.
    listReplies([machine({ createdAt: 'not-a-date' })]);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('not-a-date');
    expect(text).not.toContain('Invalid');
  });
});
