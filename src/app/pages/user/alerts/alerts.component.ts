import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import {
  NotificationCenterService,
  NotificationKind,
} from 'src/app/core/services/notification-center.service';
import { KIND_META } from 'src/app/shared/notification-bell/notification-bell.component';

/** Rows per page. Ten matches the bell's own visible window, so the two read alike. */
const PAGE_SIZE = 10;

/**
 * The full alert list, at `/alerts` and `/{orgId}/alerts`.
 *
 * Why it is a page and not a second popup
 * ---------------------------------------
 * The bell keeps the newest 50 in memory and shows them in a 420px scroll box.
 * This is the same feed with room to breathe and paging, so the popup stays a
 * glance and this stays the record.
 *
 * Why paging is client-side
 * -------------------------
 * The feed is already fully in the signal -- `NotificationCenterService` caps it
 * at 50 and holds nothing server-side to page through. Asking a route for page
 * N of a list that is already loaded would be a round trip for a `.slice()`.
 */
@Component({
  selector: 'app-alerts-page',
  imports: [MatIcon, RouterLink],
  templateUrl: './alerts.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertsPageComponent {
  protected readonly center = inject(NotificationCenterService);
  protected readonly kindMeta = KIND_META;
  protected readonly pageSize = PAGE_SIZE;
  /** Typed, so `@for` hands the template a union rather than a bare `string`. */
  protected readonly tabs: ReadonlyArray<'all' | 'unread'> = ['all', 'unread'];

  protected readonly filter = signal<'all' | 'unread'>('all');
  protected readonly page = signal(0);

  protected readonly filtered = computed(() => {
    const items = this.center.items();
    return this.filter() === 'unread' ? items.filter((item) => !item.read) : items;
  });

  protected readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.filtered().length / PAGE_SIZE)));

  /**
   * The page actually shown, CLAMPED.
   *
   * Marking everything read empties the unread list under a page that is still
   * set to 3, and an unclamped index would render an empty page with no way
   * back. Reading the clamp here means every other computed sees a valid one.
   */
  protected readonly currentPage = computed(() => Math.min(this.page(), this.pageCount() - 1));

  protected readonly visible = computed(() => {
    const start = this.currentPage() * PAGE_SIZE;
    return this.filtered().slice(start, start + PAGE_SIZE);
  });

  protected readonly rangeLabel = computed(() => {
    if (!this.filtered().length) return '0';
    const start = this.currentPage() * PAGE_SIZE + 1;
    return `${start}-${start + this.visible().length - 1}`;
  });

  protected setFilter(tab: 'all' | 'unread'): void {
    this.filter.set(tab);
    this.page.set(0);
  }

  protected go(delta: number): void {
    const next = this.currentPage() + delta;
    this.page.set(Math.min(Math.max(0, next), this.pageCount() - 1));
  }

  protected metaFor(kind: NotificationKind): { icon: string; circle: string; ring: string } {
    return this.kindMeta[kind];
  }
}
