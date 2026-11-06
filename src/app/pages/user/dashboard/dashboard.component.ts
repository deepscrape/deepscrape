import { AsyncPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import {
  BillingService,
  DeploymentService,
  OrganizationService,
} from 'src/app/core/services';
import { BrowserSessionService } from 'src/app/core/services/browser-session.service';
import { NotificationCenterService } from 'src/app/core/services/notification-center.service';
import { listStaggerAnimation } from 'src/app/animations';

/**
 * The org home page — `/{orgId}`, and bare `/dashboard` on the legacy tree.
 *
 * It renders four numbers and one team line, all from services that already
 * exist. Until now the page was an empty shell: an 855-byte class holding an
 * unused `CrawlAPIService` and a `fetchData()` that did nothing, so the page
 * every customer lands on showed a blank screen.
 *
 * What earns a place here, and why nothing else does:
 * - **Credits** — the one number that decides whether anything else works.
 *   `billing$` already holds it.
 * - **Live sessions** — a session bills one credit per started 5-minute block, so
 *   an abandoned one is money leaking in the background. A count is the only way
 *   to see that without opening the browser page.
 * - **Machines running / total** — the same argument one layer down.
 * - **Unread alerts** — already computed by the notification centre from the
 *   stream the bell subscribes to; zero extra requests.
 * - **Team** — a workspace is shared, so who is in it belongs on its home page.
 *
 * Deliberately NOT here: a usage chart (`/billing/usage` owns that series — a
 * second copy on the main route would be the duplication we just removed
 * elsewhere), recent operations (no list API exists without the operations page's
 * own filters), and per-machine stats (they need the sandbox sidecar).
 */
@Component({
  selector: 'app-dashboard',
  imports: [AsyncPipe, MatIconModule, RouterLink, TranslateModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [listStaggerAnimation],
  host: { class: 'grow' },
})
export class DashboardComponent {

  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly billing = inject(BillingService);
  private readonly browserSessions = inject(BrowserSessionService);
  private readonly machines = inject(DeploymentService);
  private readonly notifications = inject(NotificationCenterService);
  private readonly organizations = inject(OrganizationService);

  readonly billing$ = this.billing.billing$;
  readonly unread = this.notifications.unread;

  readonly orgId = signal('');
  readonly liveSessions = signal<number | null>(null);
  readonly machineTotals = signal<{ total: number; running: number } | null>(null);
  readonly memberCount = signal<number | null>(null);

  readonly openSessions = computed(() => this.liveSessions() ?? 0);

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const orgId = params.get('orgId') ?? '';
      this.orgId.set(orgId);
      this.loadTeam(orgId);
    });

    this.loadUsage();
  }

  private loadUsage(): void {
    this.browserSessions
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (reply) => this.liveSessions.set((reply.sessions ?? []).length),
        // A failed count must not take the page down: credits and alerts are the
        // numbers that block work, and they come from other services.
        error: () => this.liveSessions.set(null),
      });

    this.machines
      .listMine()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (reply) => {
          const all = reply.machines ?? [];
          this.machineTotals.set({
            total: all.length,
            running: all.filter((machine) => machine.state === 'started').length,
          });
        },
        error: () => this.machineTotals.set(null),
      });
  }

  /**
   * Members of the workspace the URL names.
   *
   * The bare `/dashboard` route carries no `orgId`, so it falls back to the
   * caller's first workspace rather than hiding the card on one of the two trees
   * that share this component.
   * @param {string} orgId The `orgId` route parameter, or an empty string.
   * @return {void} Nothing.
   */
  private loadTeam(orgId: string): void {
    if (orgId) {
      this.loadMembers(orgId);
      return;
    }

    this.organizations
      .listMyOrganizations()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (reply) => {
          const first = reply.organizations?.[0]?.id ?? '';
          this.orgId.set(first);
          this.loadMembers(first);
        },
        error: () => this.memberCount.set(null),
      });
  }

  private loadMembers(orgId: string): void {
    if (!orgId) {
      this.memberCount.set(null);
      return;
    }

    this.organizations
      .listMembers(orgId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (reply) => this.memberCount.set((reply.members ?? []).length),
        error: () => this.memberCount.set(null),
      });
  }
}
