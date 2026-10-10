import { DestroyRef, inject, Injectable } from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { BehaviorSubject, Observable, Subscription, forkJoin, of, timer } from 'rxjs'
import { catchError, map, switchMap, take } from 'rxjs/operators'
import { CrawlStatus } from '../types'
import { CrawlAPIService } from './crawlapi.service'
export interface TaskStatus {
  task_id: string
  status: string
  timestamp: number
  info?: any
  result?: any
  error?: string
  final?: boolean
}

/**
 * The statuses `deriveStatus` can report as the END of a job —
 * `functions/src/handlers/webrain-jobs.ts:68` carries the full vocabulary:
 * `"In Progress" | "Completed" | "Failed" | "Canceled"`.
 *
 * Anything NOT in this list is still running, so it keeps the poll alive. Kept
 * as data rather than a chain of `===` so the stop condition cannot drift from
 * the statuses the server can actually send.
 */
const TERMINAL_STATUSES: readonly string[] = ['Completed', 'Failed', 'Canceled']

/** How often each tracked task is re-read. */
export const TASK_POLL_INTERVAL_MS = 4000

/**
 * Task progress for the Operations page.
 *
 * This used to be a WebSocket to the legacy crawl agent
 * (`wss://agent.deepscrape.dev/api/v1/ws/task/status`) carrying the Firebase ID
 * token **in the query string**. Two problems, both structural:
 *
 *  - it bypassed the BFF entirely, so no guard, entitlement, rate limit or
 *    metering sat in front of it, and the token landed in proxy and access logs
 *    by construction;
 *  - it was the ONLY surface in the frontend that left our own origin, which the
 *    production CSP (`connect-src` in `firebase.json`) does not permit anyway.
 *
 * The replacement uses no socket and adds no route: the BFF already serves the
 * same data as SSE at `GET /api/job/stream/status/:taskId`, and
 * `CrawlAPIService.getTaskStatus` already parses it. So this class is now a
 * POLL over a guarded, same-origin route — the token rides the normal
 * `Authorization` header, and the status vocabulary is the server's own.
 *
 * The public surface is deliberately unchanged (`taskStatus$`, `getTaskStatuses`,
 * `connectAndTrackTasks`, `disconnectTaskSocket`, `closeAll`) because
 * `pages/user/operations/operations.component.ts` is the single consumer and it
 * matches rows on `task_id`. Only the transport moved.
 */
@Injectable({
  providedIn: 'root',
})
export class WebSocketService {
  private readonly destroyRef = inject(DestroyRef)
  private readonly crawlApi = inject(CrawlAPIService)

  /** The ids currently tracked, de-duplicated. */
  private trackedTaskIds: string[] = []
  /** The live poll. Non-null only while tracking, and the teardown handle. */
  private pollSubscription: Subscription | null = null

  private taskStatusSubject = new BehaviorSubject<TaskStatus[]>([])
  public taskStatus$ = this.taskStatusSubject.asObservable()
  /**
   * Connect to WebSocket and track task statuses
   * @param taskIds Array of task IDs to track
   */
  /**
   * Track the given task ids, reading their status from the BFF.
   *
   * Reads once immediately, then every `TASK_POLL_INTERVAL_MS`, and STOPS BY
   * ITSELF once every tracked task reports a terminal status — so a finished job
   * stops issuing requests while the consumer keeps its final frame.
   *
   * `switchMap` rather than `mergeMap`: if a read is still in flight when the
   * next tick arrives it is cancelled, so a slow or hung response cannot pile up
   * one outstanding request per interval.
   * @param {string[]} taskIds The task ids to follow.
   */
  connectAndTrackTasks(taskIds: string[]): void {
    if (!taskIds || taskIds.length === 0) {
      console.error('No task IDs provided')
      return
    }

    this.trackedTaskIds = [...new Set(taskIds)]
    this.disconnectTaskSocket()

    this.pollSubscription = timer(0, TASK_POLL_INTERVAL_MS)
      .pipe(
        switchMap(() => this.readTrackedTasks()),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((tasks) => {
        this.taskStatusSubject.next(tasks)
        if (tasks.length > 0 && tasks.every((task) => task.final)) {
          this.disconnectTaskSocket()
        }
      })
  }

  /**
   * Read every tracked task once. A task that errors is DROPPED rather than
   * reported as failed: a transient HTTP error is not a job outcome, and
   * inventing a `Failed` row for one would stop the poll on a job that is still
   * running.
   * @return {Observable<TaskStatus[]>} The statuses that could be read.
   */
  private readTrackedTasks(): Observable<TaskStatus[]> {
    const ids = this.trackedTaskIds
    if (ids.length === 0) {
      return of([])
    }

    const reads = ids.map((id) =>
      this.crawlApi.getTaskStatus(id).pipe(
        take(1),
        map((frame) => this.toTaskStatus(id, frame)),
        catchError(() => of(undefined))
      )
    )

    return forkJoin(reads).pipe(
      map((results) => results.filter((task): task is TaskStatus => task !== undefined))
    )
  }

  /**
   * Map one SSE frame onto the shape the Operations page matches on.
   *
   * `frame.status` is the OUTER status, which is `deriveStatus`'s own answer, and
   * is what decides `final`. The inner `result.status` is not used for that
   * decision because `CrawlAPIService` defaults it to `'Completed'` when the
   * server omits it — reading a terminal state out of a default would stop the
   * poll on a job nobody said had finished.
   * @param {string} taskId The id this frame belongs to.
   * @param {*} frame The parsed SSE frame.
   * @return {TaskStatus} The row for `taskStatus$`.
   */
  private toTaskStatus(
    taskId: string,
    frame: Pick<CrawlStatus, 'error' | 'status' | 'result'>
  ): TaskStatus {
    const status = frame?.status ?? 'In Progress'
    return {
      task_id: taskId,
      status,
      timestamp: Date.now(),
      result: frame?.result,
      error: frame?.error,
      final: TERMINAL_STATUSES.includes(status),
    }
  }

 
  /**
   * Get current task statuses
   * @return {TaskStatus[]} The latest rows pushed to `taskStatus$`.
   */
  getTaskStatuses(): TaskStatus[] {
    return this.taskStatusSubject.value
  }

  /**
   * Stop tracking.
   *
   * Keeps its old name so `operations.component.ts` does not have to change with
   * the transport — it means "stop following these tasks", and the socket is no
   * longer the thing being stopped.
   */
  disconnectTaskSocket(): void {
    this.pollSubscription?.unsubscribe()
    this.pollSubscription = null
  }

  /**
   * Release every subscription.
   *
   * The general socket is gone rather than re-pointed: its connect call was
   * commented out in the constructor, and nothing in the tree consumed
   * `messages$` or `sendMessage`, so they were two ways to reach a channel that
   * was never opened. The poll is the only subscription this class owns.
   */
  closeAll(): void {
    this.disconnectTaskSocket()
  }

  ngOnDestroy(): void {
    this.closeAll()
    this.taskStatusSubject.complete()
  }
}