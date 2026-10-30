import { ChangeDetectionStrategy, Component, OnChanges, OnInit, Input, SimpleChanges, computed, inject, signal } from '@angular/core'
import { DatePipe, TitleCasePipe } from '@angular/common'
import { MatCardModule } from '@angular/material/card'
import { MatTooltipModule } from '@angular/material/tooltip'
import { MatIconModule } from '@angular/material/icon'
import { TranslateModule } from '@ngx-translate/core'
import { FirestoreService } from '../../services/firestore.service'
import { SessionActivityPoint, SessionDisplayInfo } from '../../types/global.interface'
import { environment } from 'src/environments/environment'

/**
 * PHASE 4.3: Session Activity Visualization Component
 * Displays a sparkline/timeline of activity for a user session over time
 */
type ActivityData = SessionActivityPoint

interface DailySummary {
  date: Date
  duration: number
  requestCount: number
  status: 'active'
}

@Component({
  selector: 'app-session-activity',
  imports: [DatePipe, TitleCasePipe, MatCardModule, MatTooltipModule, MatIconModule, TranslateModule],
  templateUrl: './session-activity.component.html',
  styleUrl: './session-activity.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionActivityComponent implements OnInit, OnChanges {
  @Input() session!: SessionDisplayInfo

  private firestore = inject(FirestoreService)

  readonly activityData = signal<ActivityData[]>([])
  readonly dailySummary = signal<DailySummary[]>([])
  readonly activityBars = computed(() => {
    const data = this.activityData()
    const maxActive = Math.max(...data.map((a) => a.activeSeconds), 1)

    return data.map((activity, index) => {
      const hour = new Date(activity.timestamp).getHours()
      return {
        index,
        activity,
        height: (activity.activeSeconds / maxActive) * 100,
        tooltip: `${hour.toString().padStart(2, '0')}:00 - ${activity.activityCount} requests, ${Math.round(activity.activeSeconds)}s active`,
      }
    })
  })
  readonly totalActivity = computed(() => this.activityData().reduce((sum, a) => sum + a.activityCount, 0))
  readonly totalActiveTime = computed(() => {
    const totalSeconds = this.activityData().reduce((sum, a) => sum + a.activeSeconds, 0)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    return `${hours}h ${minutes}m`
  })
  /**
   * This used to be `totalSeconds / pointCount` labelled "Avg Session Duration",
   * which is not a duration of anything: the points are hourly buckets of ONE
   * session, so the value is how long the session was active inside an average
   * bucket. Named for what it measures.
   */
  readonly averageActivePerHour = computed(() => {
    const data = this.activityData()
    const totalSeconds = data.reduce((sum, a) => sum + a.activeSeconds, 0)
    return this.formatDuration(totalSeconds / Math.max(data.length, 1))
  })
  /**
   * The hour of the busiest point, read from its timestamp. This used to report
   * the point's array INDEX as the hour, so any series that did not start at
   * midnight named an hour that had no data behind it.
   */
  readonly peakActivityHour = computed(() => {
    const data = this.activityData()
    let maxActivity = 0
    let peak: ActivityData | null = null

    data.forEach((act) => {
      const totalAct = act.activeSeconds + act.activityCount
      if (totalAct > maxActivity) {
        maxActivity = totalAct
        peak = act
      }
    })

    if (!peak) {
      return '--:--'
    }
    const hour = new Date((peak as ActivityData).timestamp).getHours()
    return `${hour.toString().padStart(2, '0')}:00`
  })

  ngOnInit() {
    if (this.session?.sessionId) {
      this.loadActivityData(this.session.sessionId)
    }
  }

  /**
   * The parent card lets the user switch which session is visualised, and this
   * component read the input exactly once in `ngOnInit`. Switching therefore
   * left the previous session's chart on screen under the new session's name.
   *
   * @param {SimpleChanges} changes emitted by Angular on input change
   */
  ngOnChanges(changes: SimpleChanges): void {
    const change = changes['session']
    // The first change is the initial binding, which `ngOnInit` already loads.
    if (!change || change.firstChange || change.currentValue === change.previousValue) {
      return
    }
    // A new session id means the old points are somebody else's activity.
    this.activityData.set([])
    this.dailySummary.set([])
    const sessionId = (change.currentValue as SessionDisplayInfo | undefined)?.sessionId
    if (sessionId) {
      void this.loadActivityData(sessionId)
    }
  }

  /** Only allow mock fallback in dev / emulator; never in production. */
  private readonly allowMockFallback = !environment.production || environment.emulators

  private async loadActivityData(sessionId: string) {
    try {
      const firestoreData = await this.firestore.getLoginSessionActivity(sessionId)
      if (firestoreData.length > 0) {
        this.activityData.set(firestoreData)
        this.dailySummary.set(this.calculateDailySummary(firestoreData))
        return
      }
    } catch (error) {
      console.error('Failed to load activity data from Firestore:', error)
    }

    if (this.allowMockFallback) {
      const mockActivity = this.generateMockActivityData()
      this.activityData.set(mockActivity)
      this.dailySummary.set(this.calculateDailySummary(mockActivity))
    }
  }

  /**
   * Generate mock activity data for 24 hours (by hour)
   */
  private generateMockActivityData(): ActivityData[] {
    const data: ActivityData[] = []
    const createdAt = this.session.createdAt
      ? new Date(this.session.createdAt)
      : new Date()

    for (let i = 0; i < 24; i++) {
      const timestamp = new Date(createdAt.getTime() + i * 60 * 60 * 1000)
      const baseActivity = Math.random() * 100
      const variance = Math.sin(i / 4) * 50 // Add some pattern

      data.push({
        timestamp,
        activeSeconds: Math.max(0, baseActivity + variance),
        activityCount: Math.floor(Math.random() * 50),
      })
    }

    return data
  }

  /**
   * Calculate daily summary from activity data
   */
  private calculateDailySummary(activity: ActivityData[]): DailySummary[] {
    const dailyMap = new Map<string, DailySummary>()

    activity.forEach((act) => {
      const dateKey = new Date(act.timestamp).toDateString()
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, {
          date: act.timestamp,
          duration: 0,
          requestCount: 0,
          status: 'active',
        })
      }

      const daily = dailyMap.get(dateKey)!
      daily.duration += act.activeSeconds
      daily.requestCount += act.activityCount
    })

    // Encounter order is the ascending query order, so the LAST seven map entries
    // are the most recent seven days. `slice(0, 7)` kept the OLDEST seven.
    return Array.from(dailyMap.values()).slice(-7)
  }

  formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (hours > 0) {
      return `${hours}h ${minutes}m`
    }
    if (minutes > 0) {
      return `${minutes}m`
    }
    // Whole minutes made every sub-minute value render as "0m".
    return `${Math.round(seconds)}s`
  }

}
