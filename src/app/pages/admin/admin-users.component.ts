import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit, inject } from '@angular/core'
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms'
import { RouterLink } from '@angular/router'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { DialogComponent, StinputComponent } from 'src/app/core/components'
import { RippleDirective } from 'src/app/core/directives'
import {
  AdminUserFilter,
  AdminUserListItem,
  AdminUserOverview,
  AdminUsersService,
} from 'src/app/core/services'

/** Which destructive operation the confirmation dialog is currently guarding. */
type PendingActionKind = 'suspend' | 'unsuspend' | 'delete' | 'restore'

type PendingAction = {
  kind: PendingActionKind
  user: AdminUserListItem
}

/**
 * Account console for platform staff.
 *
 * The page deliberately separates reversible from irreversible:
 *   - **suspend** disables the account and signs it out. Undo is one click.
 *   - **delete** locks the account and schedules erasure after a grace window. Undo is
 *     one click *until* the nightly purger runs, which is why the button offers
 *     "cancel deletion" and the deadline is shown on every affected row.
 *
 * Nothing on this page erases data directly. That belongs to a scheduled function, so
 * the operator cannot destroy an account in a single unguarded click, and the audit
 * record is written before the state it describes is changed.
 */
@Component({
  selector: 'app-admin-users',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, RippleDirective, TranslateModule, StinputComponent, DialogComponent],
  templateUrl: './admin-users.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminUsersComponent implements OnInit {
  private readonly adminUsers = inject(AdminUsersService)
  private readonly cdr = inject(ChangeDetectorRef)
  private readonly translate = inject(TranslateService)

  readonly search = new FormControl('', { nonNullable: true })
  // Required for every destructive action: an unexplained suspension or deletion is
  // indistinguishable from an account compromise when it is reviewed later.
  readonly reason = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.minLength(3), Validators.maxLength(280)],
  })
  readonly suspendDays = new FormControl('', { nonNullable: true })

  readonly filters: AdminUserFilter[] = ['all', 'banned', 'deleted', 'admins']

  filter: AdminUserFilter = 'all'
  items: AdminUserListItem[] = []
  hasMore = false
  nextLastDocId: string | null = null
  loading = false
  error: string | null = null
  notice: string | null = null
  /** Uid whose row is mid-operation, so only that row's buttons disable. */
  busyUid: string | null = null

  selected: AdminUserListItem | null = null
  overview: AdminUserOverview | null = null
  overviewLoading = false

  pendingAction: PendingAction | null = null

  ngOnInit(): void {
    void this.load(true)
  }

  /**
   * Load a page of accounts.
   *
   * @param {boolean} reset Start from the first page.
   */
  async load(reset: boolean): Promise<void> {
    if (this.loading) {
      return
    }

    this.loading = true
    this.error = null
    this.cdr.markForCheck()

    try {
      const response = await this.adminUsers.listUsers({
        search: this.search.value.trim() || undefined,
        filter: this.filter,
        pageSize: 25,
        lastDocId: reset ? null : this.nextLastDocId,
      })

      this.items = reset ? response.items : [...this.items, ...response.items]
      this.hasMore = response.hasMore
      this.nextLastDocId = response.nextLastDocId
    } catch (caught) {
      this.error = this.messageFor(caught)
    } finally {
      this.loading = false
      this.cdr.markForCheck()
    }
  }

  /**
   * Switch the filter. Always resets paging — a cursor from one filter is meaningless in
   * another.
   *
   * @param {AdminUserFilter} filter The slice to show.
   */
  async setFilter(filter: AdminUserFilter): Promise<void> {
    if (this.filter === filter) {
      return
    }
    this.filter = filter
    this.selected = null
    this.overview = null
    await this.load(true)
  }

  async applySearch(): Promise<void> {
    this.selected = null
    this.overview = null
    await this.load(true)
  }

  async clearSearch(): Promise<void> {
    if (!this.search.value) {
      return
    }
    this.search.setValue('')
    await this.applySearch()
  }

  /**
   * Show one account's live state and audit history.
   *
   * @param {AdminUserListItem} user The row that was opened.
   */
  async open(user: AdminUserListItem): Promise<void> {
    if (this.selected?.uid === user.uid) {
      this.selected = null
      this.overview = null
      this.cdr.markForCheck()
      return
    }

    this.selected = user
    this.overview = null
    this.overviewLoading = true
    this.error = null
    this.cdr.markForCheck()

    try {
      this.overview = await this.adminUsers.getUserOverview(user.uid)
    } catch (caught) {
      this.error = this.messageFor(caught)
    } finally {
      this.overviewLoading = false
      this.cdr.markForCheck()
    }
  }

  /**
   * Open the confirmation dialog for one destructive action.
   *
   * @param {PendingActionKind} kind Which operation.
   * @param {AdminUserListItem} user The account it targets.
   */
  ask(kind: PendingActionKind, user: AdminUserListItem): void {
    this.pendingAction = { kind, user }
    this.reason.reset('')
    this.suspendDays.reset('')
    this.cdr.markForCheck()
  }

  closeDialog(): void {
    this.pendingAction = null
    this.reason.reset('')
    this.suspendDays.reset('')
    this.cdr.markForCheck()
  }

  /** Whether the reason field currently satisfies the form. */
  get reasonValid(): boolean {
    return this.reason.valid
  }

  /** Title copy for the confirmation dialog, keyed off the pending action. */
  get dialogTitle(): string {
    const kind = this.pendingAction?.kind
    const keys: Record<PendingActionKind, string> = {
      suspend: 'ADMIN_USERS.DLG_SUSPEND_TITLE',
      unsuspend: 'ADMIN_USERS.DLG_UNSUSPEND_TITLE',
      delete: 'ADMIN_USERS.DLG_DELETE_TITLE',
      restore: 'ADMIN_USERS.DLG_RESTORE_TITLE',
    }
    return kind ? this.translate.instant(keys[kind]) : ''
  }

  /** Explanatory copy for the confirmation dialog. */
  get dialogSubtitle(): string {
    const kind = this.pendingAction?.kind
    const uid = this.pendingAction?.user.uid ?? ''
    const keys: Record<PendingActionKind, string> = {
      suspend: 'ADMIN_USERS.DLG_SUSPEND_SUB',
      unsuspend: 'ADMIN_USERS.DLG_UNSUSPEND_SUB',
      delete: 'ADMIN_USERS.DLG_DELETE_SUB',
      restore: 'ADMIN_USERS.DLG_RESTORE_SUB',
    }
    return kind ? this.translate.instant(keys[kind], { uid }) : ''
  }

  /** Whether the pending action needs a typed reason (all of them do). */
  get requiresReason(): boolean {
    return this.pendingAction !== null
  }

  /**
   * Perform the confirmed action, then refresh the row and the list.
   */
  async confirmAction(): Promise<void> {
    const pending = this.pendingAction
    if (!pending) {
      return
    }

    if (this.reason.invalid) {
      this.reason.markAsTouched()
      this.cdr.markForCheck()
      return
    }

    const uid = pending.user.uid
    const reason = this.reason.value.trim()
    const days = Number(this.suspendDays.value)

    this.busyUid = uid
    this.error = null
    this.notice = null
    this.cdr.markForCheck()

    try {
      if (pending.kind === 'suspend') {
        await this.adminUsers.suspendUser({
          userId: uid,
          reason,
          days: Number.isFinite(days) && days > 0 ? Math.min(365, Math.floor(days)) : undefined,
        })
        this.notice = this.translate.instant('ADMIN_USERS.OK_SUSPENDED')
      } else if (pending.kind === 'unsuspend') {
        await this.adminUsers.unsuspendUser({ userId: uid, reason })
        this.notice = this.translate.instant('ADMIN_USERS.OK_UNSUSPENDED')
      } else if (pending.kind === 'delete') {
        const result = await this.adminUsers.scheduleAccountDeletion({ userId: uid, reason })
        this.notice = this.translate.instant('ADMIN_USERS.OK_SCHEDULED', {
          date: result.purgeAfter.slice(0, 10),
        })
      } else {
        await this.adminUsers.cancelAccountDeletion({ userId: uid, reason })
        this.notice = this.translate.instant('ADMIN_USERS.OK_RESTORED')
      }

      this.closeDialog()
      await this.load(true)

      // Refresh the open panel so the operator sees the new state rather than the state
      // the dialog was opened against.
      if (this.selected?.uid === uid) {
        const row = this.items.find((item) => item.uid === uid)
        this.selected = row ?? null
        if (row) {
          this.overview = await this.adminUsers.getUserOverview(uid)
        }
      }
    } catch (caught) {
      this.error = this.messageFor(caught)
      this.closeDialog()
    } finally {
      this.busyUid = null
      this.cdr.markForCheck()
    }
  }

  /** Human-readable status for a row. */
  statusKey(user: AdminUserListItem): string {
    if (user.purgedAt) return 'ADMIN_USERS.STATUS_ERASED'
    if (user.isDeleted) return 'ADMIN_USERS.STATUS_DELETION_SCHEDULED'
    if (user.isBanned) return 'ADMIN_USERS.STATUS_SUSPENDED'
    return 'ADMIN_USERS.STATUS_ACTIVE'
  }

  /** Badge classes for a row's status. */
  statusClasses(user: AdminUserListItem): string {
    if (user.purgedAt) return 'bg-gray-500/15 text-gray-700 dark:text-gray-300'
    if (user.isDeleted) return 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
    if (user.isBanned) return 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
    return 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300'
  }

  /** `YYYY-MM-DD` from an ISO string, or a dash. */
  formatDate(value: string | null | undefined): string {
    return value ? value.slice(0, 10) : '—'
  }

  /** Prefer a readable name over a bare uid. */
  displayName(user: { email: string | null; username: string | null; uid: string }): string {
    return user.email || user.username || user.uid
  }

  /** Translate a transport error into something an operator can act on. */
  private messageFor(caught: unknown): string {
    if (caught instanceof Error && caught.message) {
      return caught.message
    }
    return this.translate.instant('ADMIN_USERS.ERR_GENERIC')
  }
}
