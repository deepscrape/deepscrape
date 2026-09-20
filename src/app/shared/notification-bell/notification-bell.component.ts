import { ChangeDetectionStrategy, Component, DestroyRef, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatIcon } from '@angular/material/icon';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Auth, user } from '@angular/fire/auth';
import { Firestore, collection, limit, onSnapshot, orderBy, query } from '@angular/fire/firestore';
import { RippleDirective } from 'src/app/core/directives';
import { AuthService } from 'src/app/core/services/auth.service';
import { NotificationCenterService, NotificationKind } from 'src/app/core/services/notification-center.service';

const KIND_META: Record<NotificationKind, { icon: string; circle: string; ring: string }> = {
  crawl: { icon: 'travel_explore', circle: 'bg-cyan-100 dark:bg-cyan-500/20', ring: 'text-cyan-700 dark:text-cyan-300' },
  billing: { icon: 'credit_card', circle: 'bg-rose-100 dark:bg-rose-500/20', ring: 'text-rose-700 dark:text-rose-300' },
  security: { icon: 'gpp_maybe', circle: 'bg-rose-100 dark:bg-rose-500/20', ring: 'text-rose-700 dark:text-rose-300' },
  push: { icon: 'notifications_active', circle: 'bg-amber-100 dark:bg-amber-500/20', ring: 'text-amber-700 dark:text-amber-300' },
  info: { icon: 'info', circle: 'bg-gray2/60 dark:bg-white/10', ring: 'text-gray6 dark:text-gray2' },
};

/** Shape the backend writes into `users/{uid}/alerts`. */
type ServerAlert = {
  title?: string;
  message?: string;
  type?: string;
  createdAt?: { toDate?: () => Date };
};

/** Shape `recordBillingIncident` writes into `billing_incidents` (admin-only read). */
type BillingIncident = {
  type?: string;
  severity?: string;
  message?: string;
  acknowledged?: boolean;
};

@Component({
  selector: 'app-notification-bell',
  imports: [MatIcon, RouterLink, RippleDirective],
  templateUrl: './notification-bell.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // ponytail: host-level guard rather than a template wrapper — the bell is mounted by
  // several layouts (service + user) and an anonymous bell is dead UI: the feed it reads
  // is per-user (`users/{uid}/alerts`), so a guest can only ever open an empty panel.
  host: { '[class.hidden]': '!signedIn()' },
})
export class NotificationBellComponent {
  readonly center = inject(NotificationCenterService);
  readonly kindMeta = KIND_META;

  private readonly auth = inject(Auth);
  private readonly firestore = inject(Firestore);
  private readonly authService = inject(AuthService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly destroyed = inject(DestroyRef);
  private readonly seen = new Set<string>();
  private alertsUnsubscribe: (() => void) | null = null;
  private adminUnsubscribe: (() => void) | null = null;

  readonly open = signal(false);
  readonly filter = signal<'all' | 'unread'>('all');
  /** False until Firebase Auth restores a session; drives the host `hidden` class. */
  readonly signedIn = signal(false);

  /** Declared here (not inline in the template) so `tab` keeps its union type. */
  readonly tabs: ReadonlyArray<'all' | 'unread'> = ['all', 'unread'];

  /** Newest 10, or only unread when the Unread tab is active. */
  readonly visible = computed(() => {
    const items = this.center.items();
    return (this.filter() === 'unread' ? items.filter((item) => !item.read) : items).slice(0, 10);
  });

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return;

    // Server-written alerts (MFA changes, security notices, new-location logins) live in
    // users/{uid}/alerts. Subscribed here rather than inside NotificationCenterService so
    // the read cost lands only where the bell is mounted and only for a signed-in user.
    user(this.auth).pipe(takeUntilDestroyed(this.destroyed)).subscribe((account) => {
      this.signedIn.set(!!account);
      this.alertsUnsubscribe?.();
      this.alertsUnsubscribe = null;
      this.adminUnsubscribe?.();
      this.adminUnsubscribe = null;
      if (!account) return;

      // ponytail: limit(10) caps this at ~10 reads per signed-in page load. Add a paged
      // "see all" route if the full alert history is ever needed.
      const alerts = query(
        collection(this.firestore, `users/${account.uid}/alerts`),
        orderBy('createdAt', 'desc'),
        limit(10),
      );

      this.alertsUnsubscribe = onSnapshot(alerts, (snapshot) => {
        for (const change of snapshot.docChanges()) {
          // Only genuinely new docs; `seen` guards against a re-emitted snapshot.
          if (change.type !== 'added' || this.seen.has(change.doc.id)) continue;
          this.seen.add(change.doc.id);
          const alert = change.doc.data() as ServerAlert;
          this.center.push({
            // The document id is stable across reloads, which is what lets the feed
            // remember this alert was already seen.
            id: change.doc.id,
            kind: alert.type === 'warning' || alert.type === 'error' ? 'security' : 'info',
            title: alert.title || 'Notification',
            body: alert.message,
            link: '/settings/security',
          });
        }
      }, () => undefined);

      // Admin-only: the same `billing_incidents` feed the observability callable already
      // reads (written by recordBillingIncident across the Stripe webhook paths). The
      // Firestore catch-all rule restricts reads to admins, so this is denied server-side
      // for everyone else — the client check just avoids a noisy failed listener.
      if (!this.authService.isAdmin) return;

      const incidents = query(
        collection(this.firestore, 'billing_incidents'),
        orderBy('createdAt', 'desc'),
        limit(10),
      );

      this.adminUnsubscribe = onSnapshot(incidents, (snapshot) => {
        for (const change of snapshot.docChanges()) {
          const key = `incident:${change.doc.id}`;
          if (change.type !== 'added' || this.seen.has(key)) continue;
          const incident = change.doc.data() as BillingIncident;
          // `acknowledged` is set by acknowledgeBillingIncident; actioned incidents
          // are no longer alerts.
          if (incident.acknowledged === true) continue;
          this.seen.add(key);
          this.center.push({
            id: key,
            kind: incident.severity === 'info' ? 'info' : 'billing',
            title: `Admin: ${incident.type || 'billing incident'}`,
            body: incident.message,
            // Verified against user/admin.route.ts (`billing-observability`).
            link: '/admin/billing-observability',
          });
        }
      }, () => undefined);
    });
  }

  toggle(): void {
    this.open.update((isOpen) => !isOpen);
    // Opening the panel is the "read" action; no separate acknowledge step.
    if (this.open()) this.center.markAllRead();
  }

  close(): void {
    this.open.set(false);
  }

  setFilter(next: 'all' | 'unread'): void {
    this.filter.set(next);
  }
}
