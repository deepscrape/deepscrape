import { Injectable } from '@angular/core';
import { tap, takeWhile } from 'rxjs/operators';
import { CrawlStatus } from '../types';
import { CrawlAPIService } from './crawlapi.service';
import { AnalyticsService } from './analytics.service';
import { NotificationCenterService } from './notification-center.service';
import { SnackBarType } from '../components/snackbar/snackbar.component';
import { CrawlOperationStatus } from '../enum';
import { Observable } from 'rxjs/internal/Observable';

@Injectable({ providedIn: 'root' })
export class OperationStatusService {
  /** Crawl outcomes already reported, so repeated polls cannot inflate activation. */
  private readonly reportedTerminalIds = new Set<string>();

  constructor(
    private crawlService: CrawlAPIService,
    private analytics: AnalyticsService,
    private notifications: NotificationCenterService,
  ) {}

  /**
   * Activation signal: a crawl reaching a terminal state. Every crawl UI routes
   * through this service, so it is the one place worth instrumenting.
   */
  private trackTerminalStatus(taskId: string, status: CrawlOperationStatus): void {
    if (status === CrawlOperationStatus.CANCELED || this.reportedTerminalIds.has(taskId)) {
      return;
    }

    const completed = status === CrawlOperationStatus.COMPLETED;
    this.reportedTerminalIds.add(taskId);
    this.analytics
      .trackEvent(
        completed ? 'crawl_completed' : 'crawl_failed',
        { taskId },
      )
      .subscribe({ error: () => undefined });

    // The snackbar is transient; the bell keeps the outcome readable afterwards.
    // Dedupe is already handled above, so each crawl notifies exactly once.
    this.notifications.push({
      kind: 'crawl',
      title: completed ? 'Crawl completed' : 'Crawl failed',
      body: `Task ${taskId}`,
      link: '/operations',
    });
  }

  getTaskStatusWithSnackbar(
    id: string,
    showSnackbar: (msg: string, type: SnackBarType) => void
  ): Observable<Pick<CrawlStatus, 'error' | 'status' | 'result'>> {
    return this.crawlService.getTaskStatus(id).pipe(
      tap((obj) => {
        const status = obj?.status || '';
        const result = obj?.result || null;
        const resultMessage = result?.status === 'Failed' ? result?.message : 'successfully';
        if (
          [CrawlOperationStatus.COMPLETED, CrawlOperationStatus.CANCELED, CrawlOperationStatus.FAILED].includes(
            status as CrawlOperationStatus
          )
        ) {
          const messages: Record<CrawlOperationStatus, { message: string; type: SnackBarType }> = {
            [CrawlOperationStatus.COMPLETED]: { message: `Task completed ${resultMessage}!`, type: SnackBarType.success },
            [CrawlOperationStatus.CANCELED]: { message: `Task canceled ${resultMessage}!`, type: SnackBarType.info },
            [CrawlOperationStatus.FAILED]: { message: 'Task failed!', type: SnackBarType.error },
            [CrawlOperationStatus.READY]: { message: 'Task is ready to start.', type: SnackBarType.info },
            [CrawlOperationStatus.STARTED]: { message: 'Task has started.', type: SnackBarType.info },
            [CrawlOperationStatus.SCHEDULED]: { message: 'Task is scheduled.', type: SnackBarType.info },
            [CrawlOperationStatus.IN_PROGRESS]: { message: 'Task is in progress.', type: SnackBarType.info },
            [CrawlOperationStatus.PENDING]: { message: 'Task is in pending.', type: SnackBarType.info },
            [CrawlOperationStatus.PAUSED]: { message: 'Task is in paused.', type: SnackBarType.info },
          };
          const { message, type } = messages[status as CrawlOperationStatus];
          showSnackbar(message, type);
          this.trackTerminalStatus(id, status as CrawlOperationStatus);
        }
      }),
      takeWhile((obj) => (obj?.status ?? '') !== '')
    );
  }
}