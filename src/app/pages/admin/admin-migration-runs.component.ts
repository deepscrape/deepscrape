import { DatePipe, DecimalPipe, NgClass } from '@angular/common';
import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core'
import { FormControl } from '@angular/forms'
import { RouterLink } from '@angular/router'
import { SlideInModalComponent } from 'src/app/core/components'
import { RippleDirective } from 'src/app/core/directives'
import {
  QueryDocumentSnapshot,
  DocumentData,
  Firestore,
  Timestamp,
  collection,
  documentId,
  deleteDoc,
  doc,
  getCountFromServer,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  writeBatch,
} from '@angular/fire/firestore'
import { CacheService, FirestoreService } from 'src/app/core/services'
import { TranslateModule, TranslateService } from '@ngx-translate/core'

type StartedAtCursor = {
  kind: 'timestamp' | 'number' | 'string'
  value: number | string
}

type RunsPageCursor = {
  startedAt: StartedAtCursor
  docId: string
}

interface MigrationRunItem {
  id: string
  status: string
  startedAt: Date | null
  completedAt: Date | null
  failedAt: Date | null
  stoppedAt: Date | null
  fallbackAt: Date | null
  sourceGuestCount: number
  processedGuests: number
  writeTargets: number
  estimateReads: number
  estimateWrites: number
  estimateCostUsd: number
  optionsStartDate: string
  optionsEndDate: string
  chunkSize: number
}

@Component({
  selector: 'app-admin-migration-runs',
  imports: [DatePipe, DecimalPipe, NgClass, RouterLink, SlideInModalComponent, RippleDirective, TranslateModule],
  templateUrl: './admin-migration-runs.component.html',
  styleUrl: './admin-migration-runs.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AdminMigrationRunsComponent implements OnInit {
  private readonly firestoreService = inject(FirestoreService)
  private readonly cacheService = inject(CacheService)
  private readonly translate = inject(TranslateService)
  private readonly db: Firestore = this.firestoreService.getInstanceDB('easyscrape')
  private readonly pageSize = 10
  private readonly pageCursorCacheNamespace = 'admin-migration-runs:lastDocByPage'

  loading = true
  deletingAll = false
  runs: MigrationRunItem[] = []
  error: string | null = null
  currentPage = 1
  totalItems = 0
  totalPages = 1
  readonly confirmModalOpen = new FormControl<boolean>(false, { nonNullable: true })
  confirmModalTitle = 'Confirm deletion'
  confirmModalMessage = ''
  confirmModalActionLabel = 'Delete'
  confirmModalLoading = false
  private pendingRunId: string | null = null
  private pendingDeleteAll = false

  async ngOnInit(): Promise<void> {
    await this.loadRuns(1, true)
  }

  async refreshRuns(): Promise<void> {
    this.resetPaginationCache()
    await this.loadRuns(1, true)
  }

  requestDeleteRun(runId: string): void {
    this.pendingRunId = runId
    this.pendingDeleteAll = false
    this.confirmModalTitle = this.translate.instant('ADMIN_MIGRATION_RUNS.CONFIRM_DELETE_RUN_TITLE')
    this.confirmModalMessage = this.translate.instant('ADMIN_MIGRATION_RUNS.CONFIRM_DELETE_RUN_MSG', { runId })
    this.confirmModalActionLabel = this.translate.instant('ADMIN_MIGRATION_RUNS.DELETE_RUN')
    this.confirmModalOpen.setValue(true)
  }

  requestDeleteAllRunHistory(): void {
    this.pendingRunId = null
    this.pendingDeleteAll = true
    this.confirmModalTitle = this.translate.instant('ADMIN_MIGRATION_RUNS.CONFIRM_DELETE_ALL_TITLE')
    this.confirmModalMessage = this.translate.instant('ADMIN_MIGRATION_RUNS.CONFIRM_DELETE_ALL_MSG')
    this.confirmModalActionLabel = this.translate.instant('ADMIN_MIGRATION_RUNS.DELETE_ALL_HISTORY')
    this.confirmModalOpen.setValue(true)
  }

  closeConfirmModal(): void {
    if (this.confirmModalLoading) {
      return
    }

    this.confirmModalOpen.setValue(false)
    this.pendingRunId = null
    this.pendingDeleteAll = false
  }

  async confirmDeletion(): Promise<void> {
    if (this.confirmModalLoading) {
      return
    }

    this.confirmModalLoading = true

    try {
      if (this.pendingDeleteAll) {
        await this.performDeleteAllRunHistory()
      } else if (this.pendingRunId) {
        await this.performDeleteRun(this.pendingRunId)
      }
    } finally {
      this.confirmModalLoading = false
      this.closeConfirmModal()
    }
  }

  private async performDeleteRun(runId: string): Promise<void> {
    this.error = null

    try {
      await deleteDoc(doc(this.db, `migration_runs/${runId}`))
      this.resetPaginationCache()
      await this.loadRuns(this.currentPage, true)
    } catch (err) {
      this.error = err instanceof Error ? err.message : this.translate.instant('ADMIN_MIGRATION_RUNS.ERR_DELETE_RUN')
    }
  }

  private async performDeleteAllRunHistory(): Promise<void> {
    this.deletingAll = true
    this.error = null

    try {
      const runsQuery = query(collection(this.db, 'migration_runs'), orderBy('startedAt', 'desc'), limit(500))
      const runsSnap = await getDocs(runsQuery)

      if (runsSnap.empty) {
        this.runs = []
        this.totalItems = 0
        this.totalPages = 1
        this.currentPage = 1
        return
      }

      let batch = writeBatch(this.db)
      let batchOps = 0

      for (const runDoc of runsSnap.docs) {
        batch.delete(runDoc.ref)
        batchOps += 1

        if (batchOps >= 400) {
          await batch.commit()
          batch = writeBatch(this.db)
          batchOps = 0
        }
      }

      if (batchOps > 0) {
        await batch.commit()
      }

      this.runs = []
      this.totalItems = 0
      this.totalPages = 1
      this.currentPage = 1
      this.resetPaginationCache()
    } catch (err) {
      this.error = err instanceof Error ? err.message : this.translate.instant('ADMIN_MIGRATION_RUNS.ERR_CLEAR_HISTORY')
    } finally {
      this.deletingAll = false
    }
  }

  async onPageChanged(page: number): Promise<void> {
    if (page < 1 || page > this.totalPages || page === this.currentPage || this.loading) {
      return
    }

    await this.loadRuns(page)
  }

  getVisiblePageNumbers(): number[] {
    if (this.totalPages <= 7) {
      return Array.from({ length: this.totalPages }, (_, i) => i + 1)
    }

    let startPage = Math.max(2, this.currentPage - 2)
    let endPage = Math.min(this.totalPages - 1, this.currentPage + 2)

    if (this.currentPage <= 4) {
      endPage = 6
    } else if (this.currentPage >= this.totalPages - 3) {
      startPage = this.totalPages - 5
    }

    return Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage + i)
  }

  get pageCompletedRuns(): number {
    return this.runs.filter((run) => run.status === 'completed' || run.status === 'fallback-completed').length
  }

  get pageFailedRuns(): number {
    return this.runs.filter((run) => run.status === 'failed').length
  }

  get pageRunningRuns(): number {
    return this.runs.filter((run) => run.status === 'running').length
  }

  get pageProcessedGuests(): number {
    return this.runs.reduce((sum, run) => sum + run.processedGuests, 0)
  }

  get pageEstimatedCost(): number {
    return this.runs.reduce((sum, run) => sum + run.estimateCostUsd, 0)
  }

  formatStatus(status: string): string {
    if (!status) {
      return 'ADMIN_MIGRATION_RUNS.STATUS_UNKNOWN'
    }
    switch (status) {
      case 'completed':
        return 'ADMIN_MIGRATION_RUNS.STATUS_COMPLETED'
      case 'running':
        return 'ADMIN_MIGRATION_RUNS.STATUS_RUNNING'
      case 'failed':
        return 'ADMIN_MIGRATION_RUNS.STATUS_FAILED'
      case 'stopped':
        return 'ADMIN_MIGRATION_RUNS.STATUS_STOPPED'
      case 'fallback-completed':
        return 'ADMIN_MIGRATION_RUNS.STATUS_FALLBACK_COMPLETED'
      default:
        return 'ADMIN_MIGRATION_RUNS.STATUS_UNKNOWN'
    }
  }

  badgeClass(status: string): string {
    switch (status) {
      case 'completed':
        return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
      case 'running':
        return 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300'
      case 'failed':
        return 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300'
      case 'stopped':
        return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
      case 'fallback-completed':
        return 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300'
      default:
        return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
    }
  }

  private async loadRuns(page: number, forceCountRefresh = false): Promise<void> {
    this.loading = true
    this.error = null

    try {
      if (forceCountRefresh || this.totalItems === 0) {
        const countSnap = await getCountFromServer(collection(this.db, 'migration_runs'))
        this.totalItems = countSnap.data().count || 0
        this.totalPages = Math.max(1, Math.ceil(this.totalItems / this.pageSize))
      }

      if (this.totalItems === 0) {
        this.currentPage = 1
        this.totalPages = 1
        this.runs = []
        return
      }

      const safePage = Math.min(Math.max(page, 1), this.totalPages)
      const previousCursor = await this.getPageStartCursor(safePage)

      const runsQuery = previousCursor
        ? query(
          collection(this.db, 'migration_runs'),
          orderBy('startedAt', 'desc'),
          orderBy(documentId(), 'desc'),
          startAfter(this.toStartedAtOrderValue(previousCursor.startedAt), previousCursor.docId),
          limit(this.pageSize)
        )
        : query(collection(this.db, 'migration_runs'), orderBy('startedAt', 'desc'), orderBy(documentId(), 'desc'), limit(this.pageSize))
      const runsSnap = await getDocs(runsQuery)

      this.runs = runsSnap.docs.map((runDoc) => this.toRunItem(runDoc.id, runDoc.data() as DocumentData))
      this.currentPage = safePage

      const pageLastDoc = runsSnap.empty ? null : runsSnap.docs[runsSnap.docs.length - 1]
      const pageCursor = this.toRunsPageCursor(pageLastDoc)
      this.cacheService.set<number, RunsPageCursor | null>(this.pageCursorCacheNamespace, this.currentPage, pageCursor)
    } catch (err) {
      this.error = err instanceof Error ? err.message : this.translate.instant('ADMIN_MIGRATION_RUNS.ERR_LOAD_RUNS')
      this.runs = []
    } finally {
      this.loading = false
    }
  }

  private async getPageStartCursor(targetPage: number): Promise<RunsPageCursor | null> {
    if (targetPage <= 1) {
      return null
    }

    const previousPage = targetPage - 1
    if (this.cacheService.has<number>(this.pageCursorCacheNamespace, previousPage)) {
      return this.cacheService.get<number, RunsPageCursor | null>(this.pageCursorCacheNamespace, previousPage) || null
    }

    const highestCachedPage = this.cacheService.getMaxNumericKey(this.pageCursorCacheNamespace)
    let startPage = highestCachedPage > 0 ? highestCachedPage + 1 : 1
    let cursor = highestCachedPage > 0
      ? this.cacheService.get<number, RunsPageCursor | null>(this.pageCursorCacheNamespace, highestCachedPage) || null
      : null

    for (let page = startPage; page <= previousPage; page += 1) {
      const pagedQuery = cursor
        ? query(
          collection(this.db, 'migration_runs'),
          orderBy('startedAt', 'desc'),
          orderBy(documentId(), 'desc'),
          startAfter(this.toStartedAtOrderValue(cursor.startedAt), cursor.docId),
          limit(this.pageSize)
        )
        : query(collection(this.db, 'migration_runs'), orderBy('startedAt', 'desc'), orderBy(documentId(), 'desc'), limit(this.pageSize))

      const pageSnap = await getDocs(pagedQuery)
      const pageLastDoc = pageSnap.empty ? null : pageSnap.docs[pageSnap.docs.length - 1]
      const pageCursor = this.toRunsPageCursor(pageLastDoc)
      this.cacheService.set<number, RunsPageCursor | null>(this.pageCursorCacheNamespace, page, pageCursor)
      cursor = pageCursor

      if (pageSnap.empty) {
        break
      }
    }

    return this.cacheService.get<number, RunsPageCursor | null>(this.pageCursorCacheNamespace, previousPage) || null
  }

  private toRunsPageCursor(docSnapshot: QueryDocumentSnapshot<DocumentData> | null): RunsPageCursor | null {
    if (!docSnapshot) {
      return null
    }

    return {
      startedAt: this.toStartedAtCursor(docSnapshot.get('startedAt')),
      docId: docSnapshot.id,
    }
  }

  private toStartedAtCursor(value: unknown): StartedAtCursor {
    if (value instanceof Timestamp) {
      return { kind: 'timestamp', value: value.toMillis() }
    }

    if (value instanceof Date) {
      return { kind: 'timestamp', value: value.getTime() }
    }

    if (typeof value === 'number') {
      return { kind: 'number', value }
    }

    if (typeof value === 'string') {
      return { kind: 'string', value }
    }

    return { kind: 'number', value: 0 }
  }

  private toStartedAtOrderValue(cursor: StartedAtCursor): number | string | Timestamp {
    switch (cursor.kind) {
      case 'timestamp':
        return Timestamp.fromMillis(Number(cursor.value))
      case 'number':
        return Number(cursor.value)
      case 'string':
        return String(cursor.value)
      default:
        return 0
    }
  }

  private resetPaginationCache(): void {
    this.cacheService.clear(this.pageCursorCacheNamespace)
  }

  private toRunItem(id: string, data: DocumentData): MigrationRunItem {
    const options = (data['options'] as Record<string, unknown>) || {}
    const estimate = (data['estimate'] as Record<string, unknown>) || {}

    return {
      id,
      status: String(data['status'] || 'unknown'),
      startedAt: this.toDate(data['startedAt']),
      completedAt: this.toDate(data['completedAt']),
      failedAt: this.toDate(data['failedAt']),
      stoppedAt: this.toDate(data['stoppedAt']),
      fallbackAt: this.toDate(data['fallbackAt']),
      sourceGuestCount: Number(data['sourceGuestCount'] || 0),
      processedGuests: Number(data['processedGuests'] || 0),
      writeTargets: Number(data['writeTargets'] || 0),
      estimateReads: Number(estimate['reads'] || 0),
      estimateWrites: Number(estimate['writes'] || 0),
      estimateCostUsd: Number(estimate['totalCostUsd'] || 0),
      optionsStartDate: String(options['startDate'] || '-'),
      optionsEndDate: String(options['endDate'] || '-'),
      chunkSize: Number(options['chunkSize'] || 0),
    }
  }

  private toDate(value: unknown): Date | null {
    if (!value) {
      return null
    }

    if (value instanceof Timestamp) {
      return value.toDate()
    }

    if (typeof (value as { toDate?: () => Date }).toDate === 'function') {
      return (value as { toDate: () => Date }).toDate()
    }

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value
    }

    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value)
      return Number.isNaN(parsed.getTime()) ? null : parsed
    }

    return null
  }
}
