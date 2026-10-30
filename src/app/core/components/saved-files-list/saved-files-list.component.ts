import { DatePipe, DOCUMENT, NgClass, isPlatformBrowser } from '@angular/common'
import { ChangeDetectionStrategy, Component, OnInit, PLATFORM_ID, computed, inject, signal } from '@angular/core'
import { MatIcon } from '@angular/material/icon'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { BucketStorageService } from '../../services'
import { StorageObject, StorageScope } from '../../types'
import { ResultEnvelopeComponent, ResultEnvelopeState } from '../result-envelope/result-envelope.component'
import { ChartPoint, UsageHistoryChartComponent } from '../usage-history-chart/usage-history-chart.component'

/**
 * What has already been sent to storage.
 *
 * Why opening goes through `objectUrl`
 * ------------------------------------
 * The object's own URL is DISPLAYED and never used. Every open calls
 * `BucketStorageService.objectUrl`, which fetches the bytes from
 * `GET /api/storage/object` under this caller's own token and wraps them in a
 * page-local `blob:` URL. Assembling the bucket host and the key here would move
 * the storage layout into the browser; presigning would put a replayable
 * credential in a tab's address bar. Neither is done.
 *
 * Why the list is loaded once and refreshed by hand
 * -------------------------------------------------
 * A save happens on a different surface than this list, so nothing here can
 * observe it. Re-fetching on an interval would spend requests to guess, and a
 * shared event bus for one screen is a worse trade than a retry button. The
 * retry affordance is therefore the refresh.
 */
@Component({
  selector: 'app-saved-files-list',
  imports: [NgClass, MatIcon, TranslateModule, DatePipe, ResultEnvelopeComponent, UsageHistoryChartComponent],
  templateUrl: './saved-files-list.component.html',
  styleUrl: './saved-files-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SavedFilesListComponent implements OnInit {
  private readonly storage = inject(BucketStorageService)
  private readonly translate = inject(TranslateService)
  private readonly document = inject(DOCUMENT)
  private readonly platformId = inject(PLATFORM_ID)

  protected readonly state = signal<ResultEnvelopeState>('loading')
  protected readonly objects = signal<StorageObject[]>([])
  protected readonly errorMessage = signal('')
  /** The key currently being fetched, so only that row shows a spinner. */
  protected readonly openingKey = signal<string | null>(null)
  /** A failed open, which is a row-level problem rather than a page-level one. */
  protected readonly actionError = signal('')

  /**
   * Stored bytes over time, for the history chart.
   *
   * CUMULATIVE, not per-day: the question a storage chart answers is "how much am
   * I holding", so each point is the running total after that day's uploads. An
   * object with an unparseable `createdAt` is skipped rather than filed under
   * today, which would inflate the last bar with everything undated.
   */
  protected readonly storageSeries = computed<ChartPoint[]>(() => {
    const bytesByDay = new Map<string, number>()

    for (const object of this.objects()) {
      const at = new Date(object.createdAt).getTime()
      if (Number.isNaN(at)) continue
      const date = new Date(at).toISOString().slice(0, 10)
      bytesByDay.set(date, (bytesByDay.get(date) ?? 0) + (Number(object.bytes) || 0))
    }

    let running = 0
    return [...bytesByDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, bytes]) => {
        running += bytes
        return { date, value: running }
      })
  })

  ngOnInit(): void {
    this.reload()
  }

  /** Fetch the list. Also the envelope's retry action, so one path refreshes. */
  protected reload(): void {
    this.state.set('loading')
    this.errorMessage.set('')

    this.storage.list().subscribe({
      next: reply => {
        const objects = reply.objects ?? []
        this.objects.set(objects)
        this.state.set(objects.length ? 'ready' : 'empty')
      },
      error: () => {
        this.errorMessage.set(this.translate.instant('STORAGE.LIST_ERROR') as string)
        this.state.set('error')
      },
    })
  }

  /**
   * Fetch the bytes and open them from a blob URL.
   *
   * This used to presign and open the minted link, which put a bearer credential
   * in a new tab's address bar: the URL is readable from the tab's history, from
   * a shared screenshot, and by anything on the other end of `window.opener` if
   * `noopener` were ever lost. `/api/storage/object` returns the bytes to an
   * ordinary authenticated request instead, so the only credential involved is
   * the caller's own token, and the URL this opens exists only in this document.
   *
   * The blob URL is revoked immediately after the tab is opened: the browser
   * keeps the bytes alive for the tab that already holds them, and a revoked URL
   * cannot be replayed by anything else.
   */
  protected open(object: StorageObject): void {
    if (this.openingKey()) {
      return
    }

    this.actionError.set('')
    this.openingKey.set(object.key)

    this.storage.objectUrl(object.key).subscribe({
      next: url => {
        this.openingKey.set(null)
        this.openInNewTab(url)
      },
      error: () => {
        this.openingKey.set(null)
        this.actionError.set(this.translate.instant('STORAGE.OPEN_FAILED') as string)
      },
    })
  }

  private openInNewTab(url: string): void {
    if (!isPlatformBrowser(this.platformId) || !url) {
      return
    }

    // Guarded above, so `defaultView` is the real window here. `noopener` keeps
    // the new tab from reaching back through `window.opener`.
    this.document.defaultView?.open(url, '_blank', 'noopener,noreferrer')
    // Released on a delay, not immediately: the new document has to FETCH the
    // blob, and revoking before it does leaves a blank tab in browsers that had
    // not started the load. A minute is far past that point and still bounded,
    // which is the property the credential-bearing URL this replaced never had.
    setTimeout(() => this.storage.revokeObjectUrl(url), 60_000)
  }

  /** The same tone rule the save button uses, so one object reads the same in both places. */
  protected scopeClass(scope: StorageScope): string {
    return scope === 'shared'
      ? 'bg-cyan-50 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300'
      : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
  }

  protected scopeLabelKey(scope: StorageScope): string {
    return scope === 'shared' ? 'STORAGE.SCOPE_SHARED' : 'STORAGE.SCOPE_USER'
  }

  /**
   * Bytes at a human scale.
   *
   * Local rather than `FormatBytesPipe`, which is an MB-to-GB converter and
   * would report a 4 KB object as `0 GB`.
   */
  protected formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0 B'
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024
      unit++
    }

    const decimals = unit === 0 || value >= 10 ? 0 : 1
    return `${value.toFixed(decimals)} ${units[unit]}`
  }
}
