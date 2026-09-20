import { Injectable, computed, inject, PLATFORM_ID, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { LocalStorage } from './storage.service';

export type NotificationKind = 'crawl' | 'billing' | 'security' | 'push' | 'info';

export type PlatformNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string;
  at: number;
  read: boolean;
};

// ponytail: in-memory feed, capped, nothing persisted — a reload clears the LIST.
// Add a `notifications` collection + Firestore subscription only if list history
// itself must survive, which it need not: server alerts are re-read from
// users/{uid}/alerts on every load anyway.
const MAX_ITEMS = 50;

/**
 * Ids the user has already seen (read or cleared), persisted per device.
 *
 * Without this the unread badge is broken rather than merely forgetful: the
 * Firestore snapshot replays the newest 10 alerts on every page load, so anything
 * already acknowledged came back unread and the badge was pinned permanently.
 *
 * ponytail: per-device, capped at 200 ids. Move read-state onto the alert document
 * (a callable plus a rule that permits the write) only if it must follow the user
 * across devices.
 */
const SEEN_KEY = 'deepscrape.notifications.seen';
const SEEN_MAX = 200;

/**
 * In-app notification feed for the header bell.
 *
 * Reads two injection tokens and triggers no work of its own: this is mounted in
 * every layout's header, so it must not drag in side effects (payments, push
 * registration) just by being injected.
 * Producers call `push()` from wherever the real event already happens. Pass a
 * stable `id` when the same notification can be produced more than once (a
 * Firestore document id, say) so that read-state survives a re-emit.
 */
@Injectable({ providedIn: 'root' })
export class NotificationCenterService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly storage = inject(LocalStorage);
  private readonly itemsState = signal<PlatformNotification[]>([]);
  private readonly seen: Set<string> = this.readSeen();
  private seq = 0;

  readonly items = this.itemsState.asReadonly();
  readonly unread = computed(() => this.items().reduce((count, item) => (item.read ? count : count + 1), 0));

  push(input: Omit<PlatformNotification, 'id' | 'at' | 'read'> & { id?: string }): void {
    const id = input.id?.trim() || `n${++this.seq}`;
    const item: PlatformNotification = {
      ...input,
      id,
      at: Date.now(),
      // A re-emitted notification stays read instead of lighting the badge again.
      read: this.seen.has(id),
    };
    // Newest first, an existing entry for the same id replaced rather than duplicated.
    this.itemsState.update((items) =>
      [item, ...items.filter((entry) => entry.id !== id)].slice(0, MAX_ITEMS));
  }

  markAllRead(): void {
    this.remember(this.itemsState());
    this.itemsState.update((items) => items.map((item) => (item.read ? item : { ...item, read: true })));
  }

  clear(): void {
    // Clearing is the stronger form of "seen": the list empties now, and the same
    // alerts are not re-flagged unread when the snapshot replays them after a reload.
    this.remember(this.itemsState());
    this.itemsState.set([]);
  }

  private remember(items: PlatformNotification[]): void {
    for (const item of items) this.seen.add(item.id);
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      this.storage.setItem(SEEN_KEY, JSON.stringify([...this.seen].slice(-SEEN_MAX)));
    } catch {
      // Storage disabled or over quota: read-state degrades to per-session, which is
      // the previous behaviour and not worth failing a page load over.
    }
  }

  private readSeen(): Set<string> {
    if (!isPlatformBrowser(this.platformId)) return new Set();
    try {
      const parsed: unknown = JSON.parse(this.storage.getItem(SEEN_KEY) || '[]');
      const ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
      return new Set(ids);
    } catch {
      return new Set();
    }
  }

  /** "5m" / "2h" / "3d" — cheapest thing that reads as a sensible age. */
  ago(at: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 45) return 'now';
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
    return `${Math.round(seconds / 86400)}d`;
  }
}
