import { NgClass } from '@angular/common'
import { ChangeDetectionStrategy, Component, Input, inject, signal } from '@angular/core'
import { MatIcon } from '@angular/material/icon'
import { TranslateModule } from '@ngx-translate/core'
import { BucketStorageService } from '../../services'
import { StorageScope } from '../../types'

/** Where one save is in its lifecycle. `failed` is terminal until retried. */
export type StorageSaveState = 'idle' | 'saving' | 'saved' | 'failed'

/**
 * Send one URL to storage, and say where it landed.
 *
 * Why the scope is shown and not just the outcome
 * -----------------------------------------------
 * "Saved" alone does not answer the question a user actually has: can my
 * teammate open this? The server decides `shared` or `user`, so the chip prints
 * the REPLY's value and the button never claims a scope it chose itself.
 *
 * Why the state is per instance
 * -----------------------------
 * One instance owns one URL. A list of results therefore gets one independent
 * state each, so saving the third row cannot make the first row's button read
 * "saving". That is why this is a component and not a `Set` of keys in a page.
 *
 * The component holds no credential and sends no header of its own: the service
 * does that, and this type cannot name a secret.
 */
@Component({
  selector: 'app-storage-save-button',
  imports: [NgClass, MatIcon, TranslateModule],
  templateUrl: './storage-save-button.component.html',
  styleUrl: './storage-save-button.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StorageSaveButtonComponent {
  /** The absolute http(s) target. An empty value disables the button. */
  @Input() url = ''

  /** Optional name the server may store the object under. */
  @Input() filename?: string

  private readonly storage = inject(BucketStorageService)

  protected readonly state = signal<StorageSaveState>('idle')
  /** The scope the SERVER reported, not the one we hoped for. */
  protected readonly scope = signal<StorageScope | null>(null)

  /**
   * Save, once.
   *
   * A second press while a save is in flight is ignored rather than queued: the
   * route is idempotent by URL (it answers `cached: true` for a repeat), so
   * firing twice would only make the UI report two different answers.
   */
  protected save(): void {
    const url = this.url?.trim()
    if (!url || this.state() === 'saving') {
      return
    }

    this.state.set('saving')
    this.storage.save({ url, filename: this.filename }).subscribe({
      next: reply => {
        this.scope.set(reply.scope)
        this.state.set('saved')
      },
      error: () => {
        this.state.set('failed')
      },
    })
  }

  /** The button's own copy. */
  protected labelKey(): string {
    switch (this.state()) {
      case 'saving':
        return 'STORAGE.SAVING'
      case 'saved':
        return 'STORAGE.SAVED'
      case 'failed':
        return 'STORAGE.FAILED'
      default:
        return 'STORAGE.SAVE'
    }
  }

  protected iconName(): string {
    switch (this.state()) {
      case 'saving':
        return 'sync'
      case 'saved':
        return 'check_circle'
      case 'failed':
        return 'error_outline'
      default:
        return 'cloud_upload'
    }
  }

  /**
   * The button's chrome.
   *
   * `failed` is the one state a user must be able to re-enter, so it stays
   * pressable and turns rose rather than grey.
   */
  protected buttonClass(): string {
    switch (this.state()) {
      case 'saved':
        return 'bg-cyan-600 text-white dark:bg-cyan-500 dark:text-gray7'
      case 'failed':
        return 'bg-rose-50 text-rose-700 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-950/60'
      case 'saving':
        return 'bg-cyan-50 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300'
      default:
        return 'bg-cyan-600 text-white hover:bg-cyan-700 dark:bg-cyan-500 dark:text-gray7 dark:hover:bg-cyan-400'
    }
  }

  /** The chip's tone. Shared is the primary accent, private the secondary. */
  protected scopeClass(): string {
    return this.scope() === 'shared'
      ? 'bg-cyan-50 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300'
      : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
  }

  protected scopeLabelKey(): string {
    return this.scope() === 'shared' ? 'STORAGE.SCOPE_SHARED' : 'STORAGE.SCOPE_USER'
  }

  /** Long form, for the chip's tooltip, so the short label is never the whole story. */
  protected scopeHintKey(): string {
    return this.scope() === 'shared' ? 'STORAGE.SCOPE_SHARED_HINT' : 'STORAGE.SCOPE_USER_HINT'
  }
}
