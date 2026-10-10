import { DecimalPipe, NgClass } from '@angular/common';
import { Component, HostListener, OnDestroy, OnInit, inject, ChangeDetectionStrategy } from '@angular/core'
import { FormBuilder, FormControl, ReactiveFormsModule } from '@angular/forms'
import { MatDatepickerModule } from '@angular/material/datepicker'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatInputModule } from '@angular/material/input'
import { provideNativeDateAdapter } from '@angular/material/core'
import { RouterLink } from '@angular/router'
import { FirestoreService, WindowToken } from 'src/app/core/services'
import { CheckboxComponent, DropdownComponent, SlideInModalComponent } from 'src/app/core/components'
import { RippleDirective } from 'src/app/core/directives'
import {
  DocumentData,
  Firestore,
  QueryDocumentSnapshot,
  Timestamp,
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  startAfter,
  where,
  writeBatch,
} from '@angular/fire/firestore'
import { Subscription } from 'rxjs'
import { TranslateModule, TranslateService } from '@ngx-translate/core'

interface MigrationOptions {
  startDate: string
  endDate: string
  chunkSize: number
  includeDaily: boolean
  includeHourly: boolean
  includeRange: boolean
  includeSummary: boolean
  backupBeforeWrite: boolean
}

interface Estimate {
  reads: number
  writes: number
  deletes: number
  totalCostUsd: number
}

interface DailyAccumulator {
  date: string
  newGuests: number
  guestConversions: number
  byCountry: Record<string, number>
  byRegion: Record<string, number>
  byLocation: Record<string, number>
  byGeoCell: Record<string, number>
  byLatitudeBand: Record<string, number>
  byLongitudeBand: Record<string, number>
  byBrowser: Record<string, number>
  byDevice: Record<string, number>
  byOS: Record<string, number>
  byTimezone: Record<string, number>
  byLanguage: Record<string, number>
}

interface HourlyAccumulator {
  datetime: string
  date: string
  hour: number
  newGuests: number
  guestConversions: number
  byCountry: Record<string, number>
  byBrowser: Record<string, number>
  byDevice: Record<string, number>
}

@Component({
  selector: 'app-admin-migration',
  imports: [
    NgClass,
    ReactiveFormsModule,
    DecimalPipe,
    DropdownComponent,
    CheckboxComponent,
    SlideInModalComponent,
    MatFormFieldModule,
    MatInputModule,
    MatDatepickerModule,
    RouterLink,
    TranslateModule
],
  providers: [provideNativeDateAdapter()],
  templateUrl: './admin-migration.component.html',
  styleUrl: './admin-migration.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AdminMigrationComponent implements OnInit, OnDestroy {
  private readonly firestoreService = inject(FirestoreService)
  private readonly fb = inject(FormBuilder)
  private readonly window: Window = inject(WindowToken)
  private readonly db: Firestore = this.firestoreService.getInstanceDB('easyscrape')
  private readonly translate = inject(TranslateService)

  readonly form = this.fb.nonNullable.group({
    startDate: this.getDateOffset(-30),
    endDate: this.getDateOffset(0),
    chunkSize: 400,
    includeDaily: true,
    includeHourly: true,
    includeRange: true,
    includeSummary: true,
    backupBeforeWrite: true,
  })

  readonly quickRangeDropdownControl = new FormControl<{ name: string; code: string }>({
    name: 'ADMIN_ANALYTICS1.P_30D',
    code: '30',
  }, { nonNullable: true })
  readonly quickRangeDropdownOptions: Array<{ name: string; code: string }> = [
    { name: 'ADMIN_ANALYTICS1.P_7D', code: '7' },
    { name: 'ADMIN_ANALYTICS1.P_30D', code: '30' },
    { name: 'ADMIN_ANALYTICS1.P_90D', code: '90' },
    { name: 'ADMIN_MIGRATION.QUICK_YEAR_TO_DATE', code: 'ytd' },
  ]
  readonly leaveWarningModalOpen = new FormControl<boolean>(false, { nonNullable: true })

  sourceGuestCount = 0
  estimate: Estimate = { reads: 0, writes: 0, deletes: 0, totalCostUsd: 0 }

  running = false
  stopRequested = false
  progressPercent = 0
  progressLabel = 'ADMIN_MIGRATION.PROGRESS_IDLE'
  processedGuests = 0
  writeTargets = 0
  logs: string[] = []

  currentRunId: string | null = null
  lastCompletedRunId: string | null = null
  validationMessage: string | null = null
  validationOk = false
  leaveActionInProgress = false

  asBoolControl(controlName: 'includeDaily' | 'includeHourly' | 'includeRange' | 'includeSummary' | 'backupBeforeWrite'): FormControl<boolean> {
    return this.form.get(controlName) as FormControl<boolean>
  }

  private valueChangesSubscription: Subscription | null = null
  private leaveModalSubscription: Subscription | null = null
  private pendingLeaveResolver: ((allow: boolean) => void) | null = null
  private pendingHardRefresh = false

  @HostListener('window:beforeunload', ['$event'])
  handleBeforeUnload(event: BeforeUnloadEvent): void {
    if (!this.running) {
      return
    }

    event.preventDefault()
    event.returnValue = 'Migration is still running.'
  }

  @HostListener('window:keydown', ['$event'])
  handleRefreshShortcut(event: KeyboardEvent): void {
    if (!this.running) {
      return
    }

    const isF5 = event.key === 'F5'
    const isReloadCombo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r'

    if (!isF5 && !isReloadCombo) {
      return
    }

    event.preventDefault()
    this.requestPageRefresh()
  }

  ngOnInit(): void {
    this.valueChangesSubscription = this.form.valueChanges.subscribe(() => {
      this.computeEstimate()
    })

    this.leaveModalSubscription = this.leaveWarningModalOpen.valueChanges.subscribe((isOpen) => {
      if (!isOpen && this.pendingLeaveResolver) {
        this.resolveLeaveDecision(false)
      }
    })

    this.computeEstimate()
    this.loadLastCompletedRun()
  }

  ngOnDestroy(): void {
    if (this.valueChangesSubscription) {
      this.valueChangesSubscription.unsubscribe()
    }

    if (this.leaveModalSubscription) {
      this.leaveModalSubscription.unsubscribe()
    }

    this.resolveLeaveDecision(false)
  }

  requestNavigationLeave(): boolean | Promise<boolean> {
    if (!this.running) {
      return true
    }

    this.leaveWarningModalOpen.setValue(true)

    return new Promise<boolean>((resolve) => {
      this.pendingLeaveResolver = resolve
    })
  }

  stayOnMigrationPage(): void {
    this.pendingHardRefresh = false
    this.leaveWarningModalOpen.setValue(false)
    this.resolveLeaveDecision(false)
  }

  requestPageRefresh(): void {
    if (!this.running) {
      return
    }

    this.pendingHardRefresh = true
    this.leaveWarningModalOpen.setValue(true)
  }

  async confirmStopAndLeave(withFallback: boolean): Promise<void> {
    if (this.leaveActionInProgress) {
      return
    }

    this.leaveActionInProgress = true
    this.pushLog(withFallback ? 'Leave requested: stopping and attempting fallback.' : 'Leave requested: stopping migration safely.')

    try {
      this.stopMigration()
      await this.waitUntilMigrationStops()

      if (withFallback && this.lastCompletedRunId) {
        await this.fallbackFromBackup()
      }

      if (this.pendingHardRefresh) {
        this.pendingHardRefresh = false
        this.window.location.reload()
        return
      }

      this.leaveWarningModalOpen.setValue(false)
      this.resolveLeaveDecision(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown leave action error'
      this.pushLog(`Unable to complete leave action: ${message}`)
      this.leaveWarningModalOpen.setValue(true)
      this.resolveLeaveDecision(false)
    } finally {
      this.leaveActionInProgress = false
    }
  }

  async refreshEstimate(): Promise<void> {
    await this.computeEstimate(true)
  }

  applyQuickRange(days: number | null): void {
    if (days === null) {
      const now = new Date()
      const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
      this.form.patchValue({
        startDate: yearStart.toISOString().slice(0, 10),
        endDate: this.getDateOffset(0),
      })
      return
    }

    this.form.patchValue({
      startDate: this.getDateOffset(-(days - 1)),
      endDate: this.getDateOffset(0),
    })
  }

  onQuickRangeSelected(option: { name: string; code: string }): void {
    if (option.code === 'ytd') {
      this.applyQuickRange(null)
      return
    }

    const days = Number(option.code)
    if (Number.isFinite(days) && days > 0) {
      this.applyQuickRange(days)
    }
  }

  async startMigration(): Promise<void> {
    if (this.running) {
      return
    }

    const options = this.getOptions()
    if (!options) {
      this.pushLog('Invalid options. Please check dates and chunk size.')
      return
    }

    this.running = true
    this.stopRequested = false
    this.progressPercent = 0
    this.processedGuests = 0
    this.writeTargets = 0
    this.progressLabel = 'ADMIN_MIGRATION.PROGRESS_PREPARING'
    this.validationMessage = null
    this.validationOk = false
    this.currentRunId = `migration_${Date.now()}`

    await this.saveRunStatus('running', options, { startedAt: Timestamp.now() })

    try {
      this.pushLog(`Migration started (${this.currentRunId})`)

      // ponytail: metrics_daily/hourly/range/summary are owned by the realtime pipeline
      // (guest/login triggers + 30-min backfill + daily 01:00 range recompute). Migration no
      // longer writes them (Option A) and no longer calls the undeployed triggerAnalyticsAggregation
      // callable. The write path was removed — this run is bookkeeping; realtime reconciles within ~30 min.
      this.progressPercent = 100
      this.progressLabel = 'ADMIN_MIGRATION.PROGRESS_COMPLETED'
      await this.saveRunStatus('completed', options, {
        completedAt: Timestamp.now(),
      })

      this.pushLog('Migration completed — metrics are reconciled by the realtime aggregation pipeline.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown migration error'
      this.pushLog(`Migration failed: ${message}`)
      await this.saveRunStatus('failed', options, {
        failedAt: Timestamp.now(),
        errorMessage: message,
      })
    } finally {
      this.running = false
    }
  }

  stopMigration(): void {
    if (!this.running) {
      return
    }

    this.stopRequested = true
    this.progressLabel = 'ADMIN_MIGRATION.PROGRESS_STOPPING'
    this.pushLog('Stop requested. Waiting current step to finish safely...')
  }

  async validateMigration(): Promise<void> {
    this.validationMessage = null
    this.validationOk = false

    const options = this.getOptions()
    if (!options) {
      this.validationMessage = this.translate.instant('ADMIN_MIGRATION.ERR_VALIDATE_INVALID')
      return
    }

    const startTs = Timestamp.fromDate(new Date(`${options.startDate}T00:00:00.000Z`))
    const endTs = Timestamp.fromDate(new Date(`${options.endDate}T23:59:59.999Z`))

    const guestQuery = query(
      collection(this.db, 'guests'),
      where('createdAt', '>=', startTs),
      where('createdAt', '<=', endTs),
    )

    const guestCountSnap = await getCountFromServer(guestQuery)
    const expectedGuests = guestCountSnap.data().count || 0

    const dailyQuery = query(
      collection(this.db, 'metrics_daily'),
      where('date', '>=', options.startDate),
      where('date', '<=', options.endDate),
    )

    const dailySnap = await getDocs(dailyQuery)
    const migratedGuests = dailySnap.docs.reduce((sum, snap) => {
      const data = snap.data() as DocumentData
      return sum + Number(data['newGuests'] || 0)
    }, 0)

    const summarySnap = await getDoc(doc(this.db, 'metrics_summary/dashboard'))
    const summaryTotalGuests = Number((summarySnap.data() || {})['totalGuests'] || 0)

    const matched = expectedGuests === migratedGuests
    this.validationOk = matched
    const message = matched
      ? this.translate.instant('ADMIN_MIGRATION.VALIDATE_PASSED', { count: migratedGuests })
      : this.translate.instant('ADMIN_MIGRATION.VALIDATE_MISMATCH', {
        source: expectedGuests,
        metricsDaily: migratedGuests,
        summary: summaryTotalGuests,
      })
    this.validationMessage = message
    this.pushLog(message)
  }

  async fallbackFromBackup(): Promise<void> {
    if (!this.lastCompletedRunId) {
      this.pushLog('No completed run found for fallback.')
      return
    }

    const backupCollection = collection(this.db, `migration_backups/${this.lastCompletedRunId}/documents`)
    const backupSnap = await getDocs(backupCollection)

    if (backupSnap.empty) {
      this.pushLog('No backups found. Fallback unavailable for this run.')
      return
    }

    this.pushLog(`Fallback started from ${this.lastCompletedRunId} (${backupSnap.size} docs)...`)

    let batch = writeBatch(this.db)
    let opCount = 0
    let restored = 0

    for (const backupDoc of backupSnap.docs) {
      const backupData = backupDoc.data() as DocumentData
      const targetPath = String(backupData['originalPath'] || '')
      if (!targetPath) {
        continue
      }

      const targetRef = doc(this.db, targetPath)
      if (backupData['exists']) {
        batch.set(targetRef, backupData['data'] || {}, { merge: false })
      } else {
        batch.delete(targetRef)
      }

      opCount += 1
      restored += 1
      if (opCount >= 350) {
        await batch.commit()
        batch = writeBatch(this.db)
        opCount = 0
      }
    }

    if (opCount > 0) {
      await batch.commit()
    }

    await this.saveRunStatus('fallback-completed', this.getOptions(), {
      fallbackAt: Timestamp.now(),
      restoredDocs: restored,
      sourceRunId: this.lastCompletedRunId,
    })

    this.pushLog(`Fallback completed. Restored ${restored} docs.`)
  }

  get costBadge(): string {
    return `$${this.estimate.totalCostUsd.toFixed(4)} est`
  }

  private async loadLastCompletedRun(): Promise<void> {
    const runsQuery = query(
      collection(this.db, 'migration_runs'),
      where('status', '==', 'completed'),
      orderBy('startedAt', 'desc'),
      limit(1),
    )

    const runsSnap = await getDocs(runsQuery)
    this.lastCompletedRunId = runsSnap.empty ? null : runsSnap.docs[0].id
  }

  private async computeEstimate(refreshSourceCount = false): Promise<void> {
    const options = this.getOptions()
    if (!options) {
      this.estimate = { reads: 0, writes: 0, deletes: 0, totalCostUsd: 0 }
      return
    }

    if (refreshSourceCount || this.sourceGuestCount === 0) {
      const sourceQuery = query(
        collection(this.db, 'guests'),
        where('createdAt', '>=', Timestamp.fromDate(new Date(`${options.startDate}T00:00:00.000Z`))),
        where('createdAt', '<=', Timestamp.fromDate(new Date(`${options.endDate}T23:59:59.999Z`))),
      )
      const countSnap = await getCountFromServer(sourceQuery)
      this.sourceGuestCount = countSnap.data().count || 0
    }

    const days = this.daysBetween(options.startDate, options.endDate)
    const estimatedDailyDocs = options.includeDaily ? days : 0
    const estimatedHourlyDocs = options.includeHourly ? Math.min(this.sourceGuestCount, days * 24) : 0
    const estimatedRangeDocs = options.includeRange ? 3 : 0
    const estimatedSummaryDocs = options.includeSummary ? 1 : 0

    const targetDocs = estimatedDailyDocs + estimatedHourlyDocs + estimatedRangeDocs + estimatedSummaryDocs
    const backupOps = options.backupBeforeWrite ? targetDocs : 0

    const reads = this.sourceGuestCount + backupOps + 3
    const writes = targetDocs + backupOps + 2

    const readPrice = 0.03 / 100000
    const writePrice = 0.09 / 100000
    const deletePrice = 0.01 / 100000

    this.estimate = {
      reads,
      writes,
      deletes: 0,
      totalCostUsd: reads * readPrice + writes * writePrice + deletePrice * 0,
    }
  }

  private async collectGuests(options: MigrationOptions): Promise<{ daily: Map<string, DailyAccumulator>, hourly: Map<string, HourlyAccumulator> }> {
    const daily = new Map<string, DailyAccumulator>()
    const hourly = new Map<string, HourlyAccumulator>()

    let lastDoc: QueryDocumentSnapshot<DocumentData> | null = null

    while (!this.stopRequested) {
      const guestQuery = this.buildGuestPageQuery(options, lastDoc)
      const guestSnap = await getDocs(guestQuery)
      if (guestSnap.empty) {
        break
      }

      for (const guestDoc of guestSnap.docs) {
        const guest = guestDoc.data() as DocumentData
        const createdAt = this.resolveDate(guest['createdAt'])
        if (!createdAt) {
          continue
        }

        const date = createdAt.toISOString().slice(0, 10)
        const hour = createdAt.getUTCHours()
        const hourKey = `${date}-${hour.toString().padStart(2, '0')}`

        const dayAgg = this.ensureDailyAccumulator(daily, date)
        const hourAgg = this.ensureHourlyAccumulator(hourly, date, hour, hourKey)

        dayAgg.newGuests += 1
        hourAgg.newGuests += 1

        const converted = Boolean(guest['uid'] || guest['linkedAt'])
        if (converted) {
          dayAgg.guestConversions += 1
          hourAgg.guestConversions += 1
        }

        this.incrementMap(dayAgg.byCountry, String(guest['country'] || 'Unknown'))
        this.incrementMap(dayAgg.byRegion, String(guest['region'] || 'Unknown'))
        this.incrementMap(dayAgg.byLocation, String(guest['location'] || 'Unknown'))
        this.incrementMap(dayAgg.byGeoCell, this.toGeoCell(guest['latitude'], guest['longitude']))
        this.incrementMap(dayAgg.byLatitudeBand, this.toLatitudeBand(guest['latitude']))
        this.incrementMap(dayAgg.byLongitudeBand, this.toLongitudeBand(guest['longitude']))
        this.incrementMap(dayAgg.byBrowser, String(guest['browser'] || 'Unknown'))
        this.incrementMap(dayAgg.byDevice, String(guest['device'] || 'Unknown'))
        this.incrementMap(dayAgg.byOS, String(guest['os'] || 'Unknown'))
        this.incrementMap(dayAgg.byTimezone, String(guest['timezone'] || 'Unknown'))
        this.incrementMap(dayAgg.byLanguage, String(guest['language'] || 'Unknown'))

        this.incrementMap(hourAgg.byCountry, String(guest['country'] || 'Unknown'))
        this.incrementMap(hourAgg.byBrowser, String(guest['browser'] || 'Unknown'))
        this.incrementMap(hourAgg.byDevice, String(guest['device'] || 'Unknown'))

        this.processedGuests += 1
      }

      lastDoc = guestSnap.docs[guestSnap.docs.length - 1]
      this.progressLabel = 'ADMIN_MIGRATION.PROGRESS_READING'
      this.progressPercent = this.sourceGuestCount > 0 ? Math.min(65, Math.round((this.processedGuests / this.sourceGuestCount) * 65)) : 0

      if (guestSnap.docs.length < options.chunkSize) {
        break
      }
    }

    this.pushLog(`Collected ${this.processedGuests} guests across ${daily.size} day buckets.`)
    return { daily, hourly }
  }

  private async persistAggregation(
    options: MigrationOptions,
    aggregation: { daily: Map<string, DailyAccumulator>, hourly: Map<string, HourlyAccumulator> },
  ): Promise<void> {
    const writes: Array<{ path: string, data: DocumentData }> = []

    const sortedDaily = Array.from(aggregation.daily.values()).sort((a, b) => a.date.localeCompare(b.date))

    let runningTotalGuests = 0
    for (const day of sortedDaily) {
      runningTotalGuests += day.newGuests
      if (options.includeDaily) {
        writes.push({
          path: `metrics_daily/${day.date}`,
          data: {
            date: day.date,
            timestamp: Timestamp.fromDate(new Date(`${day.date}T00:00:00.000Z`)),
            totalGuests: runningTotalGuests,
            newGuests: day.newGuests,
            activeGuests: day.newGuests,
            totalUsers: 0,
            newUsers: 0,
            activeUsers: 0,
            totalLogins: 0,
            guestConversions: day.guestConversions,
            conversionRate: day.newGuests > 0 ? Math.round((day.guestConversions / day.newGuests) * 100) : 0,
            byCountry: day.byCountry,
            byRegion: day.byRegion,
            byLocation: day.byLocation,
            byGeoCell: day.byGeoCell,
            byLatitudeBand: day.byLatitudeBand,
            byLongitudeBand: day.byLongitudeBand,
            byBrowser: day.byBrowser,
            byDevice: day.byDevice,
            byOS: day.byOS,
            // byProvider omitted — preserved from real-time onLoginEvent
            byTimezone: day.byTimezone,
            topCountries: this.mapToTop(day.byCountry, 'country', 10),
            topBrowsers: this.mapToTop(day.byBrowser, 'browser', 10),
            updatedAt: Timestamp.now(),
          },
        })
      }
    }

    if (options.includeHourly) {
      const sortedHourly = Array.from(aggregation.hourly.values()).sort((a, b) => a.datetime.localeCompare(b.datetime))
      for (const hour of sortedHourly) {
        writes.push({
          path: `metrics_hourly/${hour.datetime}`,
          data: {
            datetime: hour.datetime,
            date: hour.date,
            hour: hour.hour,
            timestamp: Timestamp.now(),
            newGuests: hour.newGuests,
            newUsers: 0,
            totalLogins: 0,
            guestConversions: hour.guestConversions,
            activeGuests: hour.newGuests,
            activeUsers: 0,
            topCountries: this.mapToTop(hour.byCountry, 'country', 5),
            topBrowsers: this.mapToTop(hour.byBrowser, 'browser', 5),
            topDevices: this.mapToTop(hour.byDevice, 'device', 5),
            updatedAt: Timestamp.now(),
          },
        })
      }
    }

    if (options.includeRange) {
      writes.push(this.buildRangeWrite('last-7d', 7, sortedDaily, options.endDate))
      writes.push(this.buildRangeWrite('last-30d', 30, sortedDaily, options.endDate))
      writes.push(this.buildRangeWrite('last-90d', 90, sortedDaily, options.endDate))
    }

    if (options.includeSummary) {
      const totalGuests = sortedDaily.reduce((sum, day) => sum + day.newGuests, 0)
      const totalConversions = sortedDaily.reduce((sum, day) => sum + day.guestConversions, 0)
      const byCountry = this.mergeByKey(sortedDaily.map((d) => d.byCountry))
      const byBrowser = this.mergeByKey(sortedDaily.map((d) => d.byBrowser))
      const byDevice = this.mergeByKey(sortedDaily.map((d) => d.byDevice))
      const byOS = this.mergeByKey(sortedDaily.map((d) => d.byOS))
      const byTimezone = this.mergeByKey(sortedDaily.map((d) => d.byTimezone))

      writes.push({
        path: 'metrics_summary/dashboard',
        data: {
          totalGuests,
          activeGuests: totalGuests,
          totalUsers: 0,
          activeUsers: 0,
          totalLogins: 0,
          activeGuestsNow: 0,
          activeUsersNow: 0,
          onlineNow: 0,
          guestConversions: totalConversions,
          conversionRate: totalGuests > 0 ? Math.round((totalConversions / totalGuests) * 100) : 0,
          trends: {
            guestsGrowth: 0,
            usersGrowth: 0,
            loginsGrowth: 0,
            conversionGrowth: 0,
          },
          topCountries: this.mapToTop(byCountry, 'country', 5),
          topBrowsers: this.mapToTop(byBrowser, 'browser', 5),
          topDevices: this.mapToTop(byDevice, 'device', 5),
          topOperatingSystems: this.mapToTop(byOS, 'os', 5),
          byOS,
          // byProvider omitted — preserved from real-time onLoginEvent
          byTimezone,
          topProviders: [],
          lastUpdated: Timestamp.now(),
          computedAt: Timestamp.now(),
        },
      })
    }

    this.writeTargets = writes.length

    if (options.backupBeforeWrite && this.currentRunId) {
      this.pushLog(`Backing up ${writes.length} target docs before overwrite...`)
      await this.backupTargetDocs(writes.map((w) => w.path), this.currentRunId)
    }

    this.pushLog(`Writing ${writes.length} aggregation docs...`)
    await this.writeInBatches(writes)
  }

  private buildRangeWrite(rangeId: string, days: number, sortedDaily: DailyAccumulator[], endDate: string): { path: string, data: DocumentData } {
    const end = new Date(`${endDate}T00:00:00.000Z`)
    const start = new Date(end.getTime() - (days - 1) * 24 * 60 * 60 * 1000)

    const rangeItems = sortedDaily.filter((day) => {
      const date = new Date(`${day.date}T00:00:00.000Z`)
      return date >= start && date <= end
    })

    const byCountry = this.mergeByKey(rangeItems.map((d) => d.byCountry))
    const byRegion = this.mergeByKey(rangeItems.map((d) => d.byRegion))
    const byLocation = this.mergeByKey(rangeItems.map((d) => d.byLocation))
    const byGeoCell = this.mergeByKey(rangeItems.map((d) => d.byGeoCell))
    const byLatitudeBand = this.mergeByKey(rangeItems.map((d) => d.byLatitudeBand))
    const byLongitudeBand = this.mergeByKey(rangeItems.map((d) => d.byLongitudeBand))
    const byBrowser = this.mergeByKey(rangeItems.map((d) => d.byBrowser))
    const byDevice = this.mergeByKey(rangeItems.map((d) => d.byDevice))
    const byOS = this.mergeByKey(rangeItems.map((d) => d.byOS))
    const byTimezone = this.mergeByKey(rangeItems.map((d) => d.byTimezone))

    const newGuests = rangeItems.reduce((sum, day) => sum + day.newGuests, 0)
    const guestConversions = rangeItems.reduce((sum, day) => sum + day.guestConversions, 0)

    const dailyBreakdown = rangeItems.map((day) => ({
      date: day.date,
      newGuests: day.newGuests,
      newUsers: 0,
      totalLogins: 0,
      guestConversions: day.guestConversions,
      conversionRate: day.newGuests > 0 ? Math.round((day.guestConversions / day.newGuests) * 100) : 0,
    }))

    const peak = dailyBreakdown.reduce((acc, curr) => curr.newGuests > acc.newGuests ? curr : acc, dailyBreakdown[0] || {
      date: endDate,
      newGuests: 0,
    })

    return {
      path: `metrics_range/${rangeId}`,
      data: {
        rangeId,
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
        totalGuests: newGuests,
        newGuests,
        totalUsers: 0,
        newUsers: 0,
        totalLogins: 0,
        guestConversions,
        conversionRate: newGuests > 0 ? Math.round((guestConversions / newGuests) * 100) : 0,
        byCountry,
        byRegion,
        byLocation,
        byGeoCell,
        byLatitudeBand,
        byLongitudeBand,
        byBrowser,
        byDevice,
        byOS,
        // byProvider omitted — preserved from real-time onLoginEvent
        byTimezone,
        dailyBreakdown,
        trends: {
          avgDailyGuests: days > 0 ? Math.round(newGuests / days) : 0,
          avgDailyUsers: 0,
          avgDailyLogins: 0,
          peakDay: peak.date,
          peakValue: peak.newGuests || 0,
        },
        computedAt: Timestamp.now(),
        expiresAt: Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)),
      },
    }
  }

  private async writeInBatches(writes: Array<{ path: string, data: DocumentData }>): Promise<void> {
    let batch = writeBatch(this.db)
    let opCount = 0
    let done = 0

    for (const write of writes) {
      if (this.stopRequested) {
        throw new Error('Stopped during write phase')
      }

      // Use merge:true to preserve existing real-time fields (byProvider,
      // totalLogins, totalUsers) that the migration doesn't touch.
      batch.set(doc(this.db, write.path), write.data, { merge: true })
      opCount += 1
      done += 1

      if (opCount >= 350) {
        await batch.commit()
        batch = writeBatch(this.db)
        opCount = 0
      }

      const phaseBase = 65
      this.progressLabel = 'ADMIN_MIGRATION.PROGRESS_WRITING'
      this.progressPercent = phaseBase + Math.round((done / writes.length) * 35)
    }

    if (opCount > 0) {
      await batch.commit()
    }
  }

  private async backupTargetDocs(paths: string[], runId: string): Promise<void> {
    for (const path of paths) {
      const targetRef = doc(this.db, path)
      const targetSnap = await getDoc(targetRef)

      const backupPath = this.encodePath(path)
      const backupRef = doc(this.db, `migration_backups/${runId}/documents/${backupPath}`)
      await setDoc(backupRef, {
        originalPath: path,
        exists: targetSnap.exists(),
        data: targetSnap.exists() ? targetSnap.data() : null,
        backedUpAt: Timestamp.now(),
      }, { merge: false })
    }
  }

  private buildGuestPageQuery(options: MigrationOptions, lastDoc: QueryDocumentSnapshot<DocumentData> | null) {
    const baseConstraints: any[] = [
      where('createdAt', '>=', Timestamp.fromDate(new Date(`${options.startDate}T00:00:00.000Z`))),
      where('createdAt', '<=', Timestamp.fromDate(new Date(`${options.endDate}T23:59:59.999Z`))),
      orderBy('createdAt', 'asc'),
      limit(options.chunkSize),
    ]

    if (lastDoc) {
      baseConstraints.push(startAfter(lastDoc))
    }

    return query(collection(this.db, 'guests'), ...baseConstraints)
  }

  private ensureDailyAccumulator(map: Map<string, DailyAccumulator>, date: string): DailyAccumulator {
    const existing = map.get(date)
    if (existing) {
      return existing
    }

    const created: DailyAccumulator = {
      date,
      newGuests: 0,
      guestConversions: 0,
      byCountry: {},
      byRegion: {},
      byLocation: {},
      byGeoCell: {},
      byLatitudeBand: {},
      byLongitudeBand: {},
      byBrowser: {},
      byDevice: {},
      byOS: {},
      byTimezone: {},
      byLanguage: {},
    }

    map.set(date, created)
    return created
  }

  private ensureHourlyAccumulator(map: Map<string, HourlyAccumulator>, date: string, hour: number, datetime: string): HourlyAccumulator {
    const existing = map.get(datetime)
    if (existing) {
      return existing
    }

    const created: HourlyAccumulator = {
      datetime,
      date,
      hour,
      newGuests: 0,
      guestConversions: 0,
      byCountry: {},
      byBrowser: {},
      byDevice: {},
    }

    map.set(datetime, created)
    return created
  }

  private mapToTop(source: Record<string, number>, key: string, max = 10): Array<Record<string, number | string>> {
    return Object.entries(source)
      .sort(([, a], [, b]) => b - a)
      .slice(0, max)
      .map(([name, count]) => ({ [key]: name, count }))
  }

  private mergeByKey(objects: Record<string, number>[]): Record<string, number> {
    const result: Record<string, number> = {}
    for (const obj of objects) {
      Object.entries(obj).forEach(([key, value]) => {
        result[key] = (result[key] || 0) + value
      })
    }
    return result
  }

  private incrementMap(target: Record<string, number>, key: string): void {
    target[key] = (target[key] || 0) + 1
  }

  private toGeoCell(latitude: unknown, longitude: unknown): string {
    if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) {
      return 'Unknown'
    }

    return `${Number(latitude).toFixed(1)},${Number(longitude).toFixed(1)}`
  }

  private toLatitudeBand(latitude: unknown): string {
    if (!Number.isFinite(Number(latitude))) {
      return 'Unknown'
    }

    const value = Math.floor(Number(latitude))
    return `${value}..${value + 1}`
  }

  private toLongitudeBand(longitude: unknown): string {
    if (!Number.isFinite(Number(longitude))) {
      return 'Unknown'
    }

    const value = Math.floor(Number(longitude))
    return `${value}..${value + 1}`
  }

  private resolveDate(value: unknown): Date | null {
    if (!value) {
      return null
    }

    if (value instanceof Timestamp) {
      return value.toDate()
    }

    if (value instanceof Date) {
      return value
    }

    if (typeof (value as { toDate?: () => Date }).toDate === 'function') {
      return (value as { toDate: () => Date }).toDate()
    }

    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? null : date
    }

    return null
  }

  private daysBetween(startDate: string, endDate: string): number {
    const start = new Date(`${startDate}T00:00:00.000Z`)
    const end = new Date(`${endDate}T00:00:00.000Z`)
    const ms = end.getTime() - start.getTime()
    return Math.max(1, Math.floor(ms / (24 * 60 * 60 * 1000)) + 1)
  }

  private getDateOffset(offset: number): string {
    const date = new Date()
    date.setUTCDate(date.getUTCDate() + offset)
    return date.toISOString().slice(0, 10)
  }

  private getOptions(): MigrationOptions | null {
    const raw = this.form.getRawValue()
    const startDate = this.toIsoDateString(raw.startDate)
    const endDate = this.toIsoDateString(raw.endDate)

    if (!startDate || !endDate || Number(raw.chunkSize) <= 0) {
      return null
    }

    return {
      startDate,
      endDate,
      chunkSize: Number(raw.chunkSize),
      includeDaily: !!raw.includeDaily,
      includeHourly: !!raw.includeHourly,
      includeRange: !!raw.includeRange,
      includeSummary: !!raw.includeSummary,
      backupBeforeWrite: !!raw.backupBeforeWrite,
    }
  }

  private toIsoDateString(value: unknown): string | null {
    if (!value) {
      return null
    }

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10)
    }

    if (typeof value === 'string') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return value
      }

      const parsed = new Date(value)
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
    }

    return null
  }

  private async saveRunStatus(status: string, options: MigrationOptions | null, extra: Record<string, unknown>): Promise<void> {
    if (!this.currentRunId) {
      return
    }

    await setDoc(doc(this.db, `migration_runs/${this.currentRunId}`), {
      runId: this.currentRunId,
      status,
      options,
      sourceGuestCount: this.sourceGuestCount,
      estimate: this.estimate,
      ...extra,
    }, { merge: true })
  }

  private encodePath(path: string): string {
    return path.replace(/\//g, '__')
  }

  private pushLog(message: string): void {
    this.logs.unshift(`[${new Date().toISOString()}] ${message}`)
    if (this.logs.length > 80) {
      this.logs = this.logs.slice(0, 80)
    }
  }

  private resolveLeaveDecision(allow: boolean): void {
    if (!this.pendingLeaveResolver) {
      return
    }

    const resolve = this.pendingLeaveResolver
    this.pendingLeaveResolver = null
    resolve(allow)
  }

  private async waitUntilMigrationStops(timeoutMs = 90000): Promise<void> {
    const started = Date.now()
    while (this.running) {
      if (Date.now() - started > timeoutMs) {
        throw new Error('Timed out while waiting for migration to stop.')
      }

      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}
