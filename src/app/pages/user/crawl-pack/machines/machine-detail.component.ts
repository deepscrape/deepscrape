import { DatePipe, NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTabsModule } from '@angular/material/tabs';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { timeout } from 'rxjs';
import { DeploymentService } from 'src/app/core/services';
import { BrowserSessionService } from 'src/app/core/services/browser-session.service';
import { Machine } from 'src/app/core/types';
import { MineMachine } from 'src/app/core/types/machine-fleet.interface';

/**
 * `webrain_stats` as the engine returns it. Every field is optional because the
 * tool answers `{available: false}` off Linux, and because a partial `/proc` read
 * must not crash the page.
 */
type HostStats = {
  available?: boolean;
  load?: { m1?: number; m5?: number; m15?: number };
  memory?: { total_mb?: number; available_mb?: number };
  processes?: { total?: number; browser_processes?: number };
  uptime_s?: number;
};

/**
 * `GET /api/machines/machine/:id` answers with the Fly machine under `machine`.
 *
 * The shared `MachineResponse` type names `machine_details`, which is the DEPLOY
 * reply — a different endpoint. Typing this locally keeps the two apart instead
 * of widening a type two other callers depend on.
 */
type MachineEnvelope = {
  status?: boolean;
  message?: string;
  machine?: Machine;
  ip?: string;
};

/**
 * One machine, in detail — the page behind a row in the machine list.
 *
 * Why this is a ROUTE and not an expandable row: the list has to stay a list. A
 * machine's event log is the most useful thing the platform knows about it (it is
 * where `exit`, `oom` and `start` show up), and it is unbounded, so folding it
 * into a card would either truncate it silently or push every other machine off
 * the page.
 *
 * Where the numbers come from: exactly two existing reads, no new backend. The
 * Fly machine object (`state`, `region`, `instance_id`, `config.guest`,
 * `image_ref`, `events`, `checks`) comes from `GET /api/machines/machine/:id`,
 * which the BFF forwards to arachnefly under `paid + perm('machine','read')`.
 * `kind` and the owning session come from `GET /api/machines`, the only machine
 * read that touches Firestore.
 *
 * What it deliberately does NOT show: `config.env`. A machine document's env
 * carries `WEBRAIN_HTTP_TOKEN`, so the projection stays an allow-list of named
 * fields and never spreads `config`.
 *
 * `shortcut: no runtime stats (load, memory, disk, process list) — the sandbox
 * sidecar that would serve them does not exist yet, so arachnefly's /exec route
 * answers 502 by design. Add them here when that sidecar ships.`
 */
@Component({
  selector: 'app-machine-detail',
  imports: [
    DatePipe,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTabsModule,
    NgClass,
    RouterLink,
    TranslateModule,
  ],
  templateUrl: './machine-detail.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachineDetailComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly deployService = inject(DeploymentService);
  private readonly browserSessions = inject(BrowserSessionService);

  readonly machineId = signal('');
  readonly machine = signal<Machine | null>(null);
  readonly ownership = signal<MineMachine | null>(null);
  readonly loading = signal(true);
  readonly failed = signal(false);
  /** Null until the engine answers; `available: false` is its own case. */
  readonly stats = signal<HostStats | null>(null);
  readonly statsBusy = signal(false);

  /** Newest first. Fly appends, so the interesting event is at the end of the array. */
  readonly events = computed(() => [...(this.machine()?.events ?? [])].reverse());

  readonly checks = computed(() => this.machine()?.checks ?? []);

  /**
   * True when a browser session owns this machine.
   *
   * Read from the joined `kind`, never from the `bs-` name prefix: the prefix is a
   * convention nothing enforces, and this decides which explanation the page gives
   * for why the machine exists.
   */
  readonly sessionOwned = computed(() => Boolean(this.ownership()?.sessionId));

  readonly stateClass = computed(() => {

    const state = this.machine()?.state ?? '';
    if (state === 'started') {
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    }
    if (state === 'suspended' || state === 'stopped') {
      return 'bg-amber-500/10 text-amber-700 dark:text-amber-300';
    }
    return 'bg-gray-500/10 text-gray-600 dark:text-gray-300';
  });

  /**
   * The guest size as one line.
   *
   * Kept in the component rather than the template: the template cannot chain
   * optionals through `config.guest` (both are non-nullable in the Fly type), and a
   * raw upstream object is still worth reading defensively.
   * @return {string} `cpu_kind · N CPU · M MB`, or an em dash.
   */
  readonly guestLabel = computed(() => {
    const guest = this.machine()?.config?.guest;
    return guest ? `${guest.cpu_kind} · ${guest.cpus} CPU · ${guest.memory_mb} MB` : '—';
  });

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = params.get('machineId') ?? '';
      this.machineId.set(id);
      if (id) {
        this.load(id);
      }
    });
  }

  /**
   * The image as one line, without the registry host.
   * @return {string} `repository:tag`, or the bare image string.
   */
  imageLabel(): string {
    const ref = this.machine()?.image_ref;
    const image = this.machine()?.config?.image;
    if (ref?.repository) {
      return ref.tag ? `${ref.repository}:${ref.tag}` : ref.repository;
    }
    return image ?? '—';
  }

  /**
   * The first 12 characters of the image digest, which is all anyone compares.
   * @return {string} A short digest, or an em dash.
   */
  shortDigest(): string {
    const digest = this.machine()?.image_ref?.digest;
    return digest ? digest.slice(0, 19) : '—';
  }

  private load(id: string): void {
    this.loading.set(true);
    this.failed.set(false);

    this.deployService
      .getMachine(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (reply) => {
          this.machine.set((reply as unknown as MachineEnvelope)?.machine ?? null);
          this.loading.set(false);
        },
        error: (error: unknown) => {
          console.error('Error loading machine detail:', error);
          this.failed.set(true);
          this.loading.set(false);
        },
      });

    // Separate read, and a separate failure: `kind` is advisory. A list read that
    // times out must not hide a machine the detail read already returned.
    this.deployService
      .listMine()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (reply) => {
          const owned = (reply.machines ?? []).find((item) => item.id === id) ?? null;
          this.ownership.set(owned);
          // Runtime stats come from the engine inside the machine, so they need a
          // session: a plain container has no webrain to ask, and the card says so
          // instead of showing zeros.
          if (owned?.sessionId) {
            this.loadStats(owned.sessionId);
          }
        },
        error: () => this.ownership.set(null),
      });
  }

  /**
   * Ask the leased machine for its own `/proc`.
   *
   * Goes through `POST /api/browser/session/:id/tool`, the audited machine-direct
   * route, so `webrain_stats` needed no new endpoint — only a `SESSION_TOOLS` entry.
   * @param {string} sessionId The session that owns this machine.
   * @return {void} Nothing.
   */
  private loadStats(sessionId: string): void {
    this.statsBusy.set(true);
    this.browserSessions
      .tool(sessionId, 'webrain_stats')
      // A wedged machine never answers, and a spinner is indistinguishable from
      // "slow" without a deadline. The error handler already renders unavailable.
      .pipe(timeout(8000), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (reply) => {
          const result = reply?.result as HostStats | string | undefined;
          // The route relays the engine's text payload; parse it when it arrives as
          // a string rather than silently rendering nothing.
          this.stats.set(typeof result === 'string' ? this.parseStats(result) : result ?? null);
          this.statsBusy.set(false);
        },
        error: () => {
          this.stats.set(null);
          this.statsBusy.set(false);
        },
      });
  }

  private parseStats(text: string): HostStats | null {
    try {
      return JSON.parse(text) as HostStats;
    } catch {
      return null;
    }
  }
}
