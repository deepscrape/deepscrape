import { ChangeDetectionStrategy, Component, OnInit, Input, computed, inject, signal } from '@angular/core'
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
export class SessionActivityComponent implements OnInit {
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
  readonly averageSessionDuration = computed(() => {
    const data = this.activityData()
    const totalSeconds = data.reduce((sum, a) => sum + a.activeSeconds, 0)
    const avgSeconds = totalSeconds / Math.max(data.length, 1)
    return `${Math.round(avgSeconds / 60)}m`
  })
  readonly peakActivityHour = computed(() => {
    let maxActivity = 0
    let peakHour = 0

    this.activityData().forEach((act, i) => {
      const totalAct = act.activeSeconds + act.activityCount
      if (totalAct > maxActivity) {
        maxActivity = totalAct
        peakHour = i
      }
    })

    return `${peakHour.toString().padStart(2, '0')}:00`
  })

  ngOnInit() {
    if (this.session?.sessionId) {
      this.loadActivityData(this.session.sessionId)
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

    return Array.from(dailyMap.values()).slice(0, 7) // Last 7 days
  }

  formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (hours > 0) {
      return `${hours}h ${minutes}m`
    }
    return `${minutes}m`
  }

}
