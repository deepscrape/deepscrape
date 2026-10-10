import { DatePipe, DOCUMENT, NgClass, isPlatformBrowser } from '@angular/common'
import { ChangeDetectionStrategy, Component, OnInit, PLATFORM_ID, inject, signal } from '@angular/core'
import { MatIcon } from '@angular/material/icon'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { BucketStorageService } from '../../services'
import { StorageObject, StorageScope } from '../../types'
import { ResultEnvelopeComponent, ResultEnvelopeState } from '../result-envelope/result-envelope.component'

/**
 * What has already been sent to storage.
 *
 * Why opening goes through `presign`
 * ----------------------------------
 * The object's own URL is DISPLAYED and never used. Every open calls
 * `POST /api/storage/presign` and follows whatever URL comes back, because the
 * alternative (assembling the bucket host and the key here) would move the
 * storage layout into the browser and break the first time the layout changes.
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
  imports: [NgClass, MatIcon, TranslateModule, DatePipe, ResultEnvelopeComponent],
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
  /** The key currently being presigned, so only that row shows a spinner. */
  protected readonly openingKey = signal<string | null>(null)
  /** A failed open, which is a row-level problem rather than a page-level one. */
  protected readonly actionError = signal('')

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
   * Mint a link and open it.
   *
   * The URL is not held in a signal after the click: it is short-lived by
   * design, and keeping it on the component would leave a live download link
   * sitting in memory for the life of the page.
   */
  protected open(object: StorageObject): void {
    if (this.openingKey()) {
      return
    }

    this.actionError.set('')
    this.openingKey.set(object.key)

    this.storage.presign(object.key).subscribe({
      next: reply => {
        this.openingKey.set(null)
        this.openInNewTab(reply.url)
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
