import { TestBed } from '@angular/core/testing';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, throwError } from 'rxjs';
import { MachineDetailComponent } from './machine-detail.component';
import { DeploymentService } from 'src/app/core/services';
import { getTestProviders } from 'src/app/testing';
import { BrowserSessionService } from 'src/app/core/services/browser-session.service';
import { Machine, MachineResponse } from 'src/app/core/types';

/**
 * A machine exactly as arachnefly relays it from Fly: the envelope key is
 * `machine`, which is why the component types its own envelope. `config.env` is
 * present on purpose — it carries `WEBRAIN_HTTP_TOKEN`, and the page must never
 * render it.
 */
const machineReply = {
  status: true,
  message: 'Machine details',
  ip: 'fdaa:0:1::2',
  machine: {
    id: '1857014a0e7989',
    name: 'bs-sess-1',
    state: 'started',
    region: 'iad',
    instance_id: '01J9Z5K8XW',
    private_ip: 'fdaa:0:1::2',
    created_at: '2026-10-28T10:00:00Z',
    updated_at: '2026-10-28T11:00:00Z',
    config: {
      image: 'registry.fly.io/deepscrape-browser-session:latest',
      env: { WEBRAIN_HTTP_TOKEN: 'must-never-render' },
      guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 },
    },
    image_ref: { repository: 'deepscrape-browser-session', tag: 'latest', digest: 'sha256:abcdef0123456789' },
    checks: [{ name: 'webrain', status: 'passing', updated_at: '2026-10-28T11:00:00Z' }],
    events: [
      { type: 'start', status: 'started', source: 'flyd', timestamp: 1761645600 },
      { type: 'exit', status: 'exited', source: 'flyd', timestamp: 1761649200 },
    ],
  } as unknown as Machine,
};

describe('MachineDetailComponent', () => {
  let deployService: Partial<DeploymentService>;

  const build = async () => {
    await TestBed.configureTestingModule({
      imports: [MachineDetailComponent, BrowserAnimationsModule],
      providers: [
        ...getTestProviders(),
        { provide: DeploymentService, useValue: deployService },
        {
          provide: BrowserSessionService,
          useValue: {
            // The engine answers with its own JSON text; parse path covered below.
            tool: () =>
              of({
                tool: 'webrain_stats',
                result: JSON.stringify({
                  available: true,
                  load: { m1: 0.5, m5: 0.4, m15: 0.3 },
                  memory: { total_mb: 2000, available_mb: 500 },
                  processes: { total: 40, browser_processes: 12 },
                  uptime_s: 900,
                }),
              }),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ machineId: '1857014a0e7989' })) },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(MachineDetailComponent);
    fixture.detectChanges();
    return fixture;
  };

  beforeEach(() => {
    deployService = {
      getMachine: () => of(machineReply as unknown as MachineResponse),
      listMine: () =>
        of({
          status: 'ok' as const,
          machines: [
            {
              id: '1857014a0e7989',
              name: 'bs-sess-1',
              state: 'started',
              region: 'iad',
              createdAt: '2026-10-28T10:00:00Z',
              updatedAt: '2026-10-28T11:00:00Z',
              kind: 'browser-session' as const,
              sessionId: 'sess-1',
            },
          ],
        }),
    };
  });

  it('reads the machine id from the route and loads the machine', async () => {
    const fixture = await build();
    const component = fixture.componentInstance;

    expect(component.machineId()).toBe('1857014a0e7989');
    expect(component.machine()?.state).toBe('started');
  });

  it('reverses the event log, because Fly appends and the newest event matters most', async () => {
    const fixture = await build();
    expect(fixture.componentInstance.events()[0].type).toBe('exit');
  });

  it('marks a machine a session owns', async () => {
    const fixture = await build();
    expect(fixture.componentInstance.sessionOwned()).toBe(true);
  });

  it('leaves a machine no session claims unmarked', async () => {
    deployService.listMine = () => of({ status: 'ok' as const, machines: [] });
    const fixture = await build();
    expect(fixture.componentInstance.sessionOwned()).toBe(false);
  });

  it('never renders the machine env, which carries the worker token', async () => {
    const fixture = await build();
    expect(fixture.nativeElement.textContent).not.toContain('must-never-render');
  });

  it('shows a failure state rather than an empty page when the read fails', async () => {
    deployService.getMachine = () => throwError(() => new Error('502'));
    const fixture = await build();

    expect(fixture.componentInstance.failed()).toBe(true);
    expect(fixture.componentInstance.loading()).toBe(false);
  });
});
