import { DatePipe, DecimalPipe, NgClass } from '@angular/common';
import { ChangeDetectorRef, Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core'
import { FormControl } from '@angular/forms'
import { RouterLink } from '@angular/router'
import { SlideInModalComponent } from 'src/app/core/components/slide-in-modal/slide-in-modal.component'
import { RippleDirective } from 'src/app/core/directives'
import {
  DocumentData,
  Firestore,
  Query,
  QuerySnapshot,
  QueryDocumentSnapshot,
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

type BackupsPageCursor = {
  startedAt: StartedAtCursor
  docId: string
}

interface BackupRunItem {
  runId: string
  status: string
  startedAt: Date | null
  completedAt: Date | null
  backupCount: number
  lastBackedUpAt: Date | null
}

@Component({
  selector: 'app-admin-migration-backups',
  imports: [DatePipe, DecimalPipe, NgClass, RouterLink, SlideInModalComponent, RippleDirective, TranslateModule],
  templateUrl: './admin-migration-backups.component.html',
  styleUrl: './admin-migration-backups.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AdminMigrationBackupsComponent implements OnInit {
  private readonly firestoreService = inject(FirestoreService)
  private readonly cacheService = inject(CacheService)
  private readonly cdr = inject(ChangeDetectorRef)
  private readonly translate = inject(TranslateService)
  private readonly db: Firestore = this.firestoreService.getInstanceDB('easyscrape')
  private readonly pageSize = 10
  private readonly pageCursorCacheNamespace = 'admin-migration-backups:lastDocByPage'

  loading = true
  deletingAll = false
  error: string | null = null
  backups: BackupRunItem[] = []
  currentPage = 1
  totalItems = 0
  totalPages = 1
  deletingBackupRunIds = new Set<string>()
  deletingRunIds = new Set<string>()
  readonly confirmModalOpen = new FormControl<boolean>(false, { nonNullable: true })
  confirmModalTitle = 'Confirm deletion'
  confirmModalMessage = ''
  confirmModalActionLabel = 'Delete'
  confirmModalLoading = false
  private pendingAction: 'delete-backups' | 'delete-run' | 'delete-all-backups' | null = null
  private pendingRunId: string | null = null

  async ngOnInit(): Promise<void> {
    await this.loadBackups(1, true)
  }

  async refreshBackups(): Promise<void> {
    this.resetPaginationCache()
    await this.loadBackups(1, true)
  }

  requestDeleteRunBackups(runId: string): void {
    if (this.deletingBackupRunIds.has(runId) || this.deletingRunIds.has(runId)) {
      return
    }

    this.pendingAction = 'delete-backups'
    this.pendingRunId = runId
    this.confirmModalTitle = this.translate.instant('ADMIN_MIGRATION_BACKUPS.CONFIRM_DELETE_BACKUPS_TITLE')
    this.confirmModalMessage = this.translate.instant('ADMIN_MIGRATION_BACKUPS.CONFIRM_DELETE_BACKUPS_MSG', { runId })
    this.confirmModalActionLabel = this.translate.instant('ADMIN_MIGRATION_BACKUPS.DELETE_BACKUPS')
    this.confirmModalOpen.setValue(true)
  }

  requestDeleteMigrationRun(runId: string): void {
    if (this.deletingRunIds.has(runId) || this.deletingBackupRunIds.has(runId)) {
      return
    }

    this.pendingAction = 'delete-run'
    this.pendingRunId = runId
    this.confirmModalTitle = this.translate.instant('ADMIN_MIGRATION_RUNS.CONFIRM_DELETE_RUN_TITLE')
    this.confirmModalMessage = this.translate.instant('ADMIN_MIGRATION_BACKUPS.CONFIRM_DELETE_RUN_MSG', { runId })
    this.confirmModalActionLabel = this.translate.instant('ADMIN_MIGRATION_BACKUPS.DELETE_RUN')
    this.confirmModalOpen.setValue(true)
  }

  requestDeleteAllBackupsHistory(): void {
    this.pendingAction = 'delete-all-backups'
    this.pendingRunId = null
    this.confirmModalTitle = this.translate.instant('ADMIN_MIGRATION_BACKUPS.CONFIRM_DELETE_ALL_TITLE')
    this.confirmModalMessage = this.translate.instant('ADMIN_MIGRATION_BACKUPS.CONFIRM_DELETE_ALL_MSG')
    this.confirmModalActionLabel = this.translate.instant('ADMIN_MIGRATION_BACKUPS.DELETE_ALL_BACKUP_HISTORY')
    this.confirmModalOpen.setValue(true)
  }

  closeConfirmModal(): void {
    if (this.confirmModalLoading) {
      return
    }

    this.confirmModalOpen.setValue(false)
    this.pendingAction = null
    this.pendingRunId = null
  }

  async confirmDeletion(): Promise<void> {
    if (this.confirmModalLoading) {
      return
    }

    this.confirmModalLoading = true

    try {
      if (this.pendingAction === 'delete-all-backups') {
        await this.performDeleteAllBackupsHistory()
      } else if (this.pendingAction === 'delete-backups' && this.pendingRunId) {
        await this.performDeleteRunBackups(this.pendingRunId)
      } else if (this.pendingAction === 'delete-run' && this.pendingRunId) {
        await this.performDeleteMigrationRun(this.pendingRunId)
      }
    } finally {
      this.confirmModalLoading = false
      this.closeConfirmModal()
      this.renderNow()
    }
  }

  private async performDeleteRunBackups(runId: string): Promise<void> {
    this.deletingBackupRunIds.add(runId)
    this.error = null

    try {
      await this.deleteBackupDocumentsForRun(runId)
      this.resetPaginationCache()
      await this.loadBackups(this.currentPage, true)
    } catch (err) {
      this.error = err instanceof Error ? err.message : this.translate.instant('ADMIN_MIGRATION_BACKUPS.ERR_DELETE_BACKUPS')
    } finally {
      this.deletingBackupRunIds.delete(runId)
      this.renderNow()
    }
  }

  private async performDeleteMigrationRun(runId: string): Promise<void> {
    if (this.deletingRunIds.has(runId) || this.deletingBackupRunIds.has(runId)) {
      return
    }

    this.deletingRunIds.add(runId)
    this.error = null

    try {
      await this.deleteBackupDocumentsForRun(runId)
      await deleteDoc(doc(this.db, `migration_runs/${runId}`))
      this.resetPaginationCache()
      await this.loadBackups(this.currentPage, true)
    } catch (err) {
      this.error = err instanceof Error ? err.message : this.translate.instant('ADMIN_MIGRATION_BACKUPS.ERR_DELETE_RUN')
    } finally {
      this.deletingRunIds.delete(runId)
      this.renderNow()
    }
  }

  private async performDeleteAllBackupsHistory(): Promise<void> {
    this.deletingAll = true
    this.error = null

    try {
      const runIds = this.backups.filter((item) => item.backupCount > 0).map((item) => item.runId)
      for (const runId of runIds) {
        await this.deleteBackupDocumentsForRun(runId)
      }

      this.resetPaginationCache()
      await this.loadBackups(this.currentPage, true)
    } catch (err) {
      this.error = err instanceof Error ? err.message : this.translate.instant('ADMIN_MIGRATION_BACKUPS.ERR_CLEAR_HISTORY')
    } finally {
      this.deletingAll = false
      this.renderNow()
    }
  }

  async onPageChanged(page: number): Promise<void> {
    if (page < 1 || page > this.totalPages || page === this.currentPage || this.loading) {
      return
    }

    await this.loadBackups(page)
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

  get pageRunsWithBackups(): number {
    return this.backups.filter((backup) => backup.backupCount > 0).length
  }

  get pageBackupDocuments(): number {
    return this.backups.reduce((sum, backup) => sum + backup.backupCount, 0)
  }

  get pageCompletedRuns(): number {
    return this.backups.filter((backup) => backup.status === 'completed' || backup.status === 'fallback-completed').length
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

  statusLabel(status: string): string {
    switch (status) {
      case 'completed':
        return 'ADMIN_MIGRATION_BACKUPS.STATUS_COMPLETED'
      case 'running':
        return 'ADMIN_MIGRATION_BACKUPS.STATUS_RUNNING'
      case 'failed':
        return 'ADMIN_MIGRATION_BACKUPS.STATUS_FAILED'
      case 'stopped':
        return 'ADMIN_MIGRATION_BACKUPS.STATUS_STOPPED'
      case 'fallback-completed':
        return 'ADMIN_MIGRATION_BACKUPS.STATUS_FALLBACK_COMPLETED'
      default:
        return 'ADMIN_MIGRATION_BACKUPS.STATUS_UNKNOWN'
    }
  }

  private async loadBackups(page: number, forceCountRefresh = false): Promise<void> {
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
        this.backups = []
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

      const runItems = await Promise.all(
        runsSnap.docs.map(async (runDoc) => {
          const runData = runDoc.data() as DocumentData
          const backupCollectionRef = collection(this.db, `migration_backups/${runDoc.id}/documents`)
          const [backupCountSnap, latestBackupSnap] = await Promise.all([
            getCountFromServer(backupCollectionRef),
            getDocs(query(backupCollectionRef, orderBy('backedUpAt', 'desc'), limit(1))),
          ])

          const latestDoc = latestBackupSnap.empty ? null : latestBackupSnap.docs[0]
          const latestData = latestDoc ? (latestDoc.data() as DocumentData) : null

          const item: BackupRunItem = {
            runId: runDoc.id,
            status: String(runData['status'] || 'unknown'),
            startedAt: this.toDate(runData['startedAt']),
            completedAt: this.toDate(runData['completedAt']),
            backupCount: backupCountSnap.data().count || 0,
            lastBackedUpAt: this.toDate(latestData ? latestData['backedUpAt'] : null),
          }

          return item
        }),
      )

      this.backups = runItems
      this.currentPage = safePage

      const pageLastDoc = runsSnap.empty ? null : runsSnap.docs[runsSnap.docs.length - 1]
      const pageCursor = this.toBackupsPageCursor(pageLastDoc)
      this.cacheService.set<number, BackupsPageCursor | null>(this.pageCursorCacheNamespace, this.currentPage, pageCursor)
    } catch (err) {
      this.error = err instanceof Error ? err.message : this.translate.instant('ADMIN_MIGRATION_BACKUPS.ERR_LOAD_BACKUPS')
      this.backups = []
    } finally {
      this.loading = false
      this.renderNow()
    }
  }

  private renderNow(): void {
    this.cdr.detectChanges()
  }

  private async getPageStartCursor(targetPage: number): Promise<BackupsPageCursor | null> {
    if (targetPage <= 1) {
      return null
    }

    const previousPage = targetPage - 1
    if (this.cacheService.has<number>(this.pageCursorCacheNamespace, previousPage)) {
      return this.cacheService.get<number, BackupsPageCursor | null>(this.pageCursorCacheNamespace, previousPage) || null
    }

    const highestCachedPage = this.cacheService.getMaxNumericKey(this.pageCursorCacheNamespace)
    let startPage = highestCachedPage > 0 ? highestCachedPage + 1 : 1
    let cursor = highestCachedPage > 0
      ? this.cacheService.get<number, BackupsPageCursor | null>(this.pageCursorCacheNamespace, highestCachedPage) || null
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
      const pageCursor = this.toBackupsPageCursor(pageLastDoc)
      this.cacheService.set<number, BackupsPageCursor | null>(this.pageCursorCacheNamespace, page, pageCursor)
      cursor = pageCursor

      if (pageSnap.empty) {
        break
      }
    }

    return this.cacheService.get<number, BackupsPageCursor | null>(this.pageCursorCacheNamespace, previousPage) || null
  }

  private toBackupsPageCursor(docSnapshot: QueryDocumentSnapshot<DocumentData> | null): BackupsPageCursor | null {
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

  private async deleteBackupDocumentsForRun(runId: string): Promise<void> {
    const backupCollectionRef = collection(this.db, `migration_backups/${runId}/documents`)
    let lastDoc: QueryDocumentSnapshot<DocumentData> | null = null

    while (true) {
      let backupQuery: Query<DocumentData>
      if (lastDoc) {
        backupQuery = query(backupCollectionRef, orderBy('backedUpAt', 'asc'), startAfter(lastDoc), limit(350))
      } else {
        backupQuery = query(backupCollectionRef, orderBy('backedUpAt', 'asc'), limit(350))
      }

      const backupSnap: QuerySnapshot<DocumentData> = await getDocs(backupQuery)
      if (backupSnap.empty) {
        break
      }

      const batch = writeBatch(this.db)
      for (const backupDoc of backupSnap.docs) {
        batch.delete(doc(this.db, `migration_backups/${runId}/documents/${backupDoc.id}`))
      }

      await batch.commit()
      lastDoc = backupSnap.docs[backupSnap.docs.length - 1]

      if (backupSnap.size < 350) {
        break
      }
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
