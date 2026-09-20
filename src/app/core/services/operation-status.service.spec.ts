import { OperationStatusService } from './operation-status.service';
import { CrawlAPIService } from './crawlapi.service';
import { AnalyticsService } from './analytics.service';
import { NotificationCenterService } from './notification-center.service';
import { of } from 'rxjs';
import { SnackBarType } from '../components/snackbar/snackbar.component';
import { CrawlOperationStatus } from '../enum';

describe('OperationStatusService', () => {
  let service: OperationStatusService;
  let crawlServiceMock: jasmine.SpyObj<CrawlAPIService>;
  let analyticsMock: jasmine.SpyObj<AnalyticsService>;
  let notificationsMock: jasmine.SpyObj<NotificationCenterService>;

  beforeEach(() => {
    crawlServiceMock = jasmine.createSpyObj('CrawlAPIService', ['getTaskStatus']);
    analyticsMock = jasmine.createSpyObj('AnalyticsService', ['trackEvent']);
    analyticsMock.trackEvent.and.returnValue(of(null));
    // Pre-existing staleness: the service grew a third constructor arg and this spec
    // was never updated, so the whole suite failed to compile before any test ran.
    notificationsMock = jasmine.createSpyObj('NotificationCenterService', ['push']);
    service = new OperationStatusService(crawlServiceMock, analyticsMock, notificationsMock);
  });

  it('should emit task status values from the crawl service', (done) => {
    crawlServiceMock.getTaskStatus.and.returnValue(of({ status: CrawlOperationStatus.IN_PROGRESS, result: null } as any));

    service.getTaskStatusWithSnackbar('task-1', () => undefined).subscribe((value) => {
      expect(value.status).toBe(CrawlOperationStatus.IN_PROGRESS);
      expect(analyticsMock.trackEvent).not.toHaveBeenCalled();
      done();
    });
  });

  it('should show a success snackbar when a task completes', (done) => {
    const snackbarSpy = jasmine.createSpy('showSnackbar');
    crawlServiceMock.getTaskStatus.and.returnValue(
      of({ status: CrawlOperationStatus.COMPLETED, result: { status: 'Success', message: 'ok' } } as any),
    );

    service.getTaskStatusWithSnackbar('task-1', snackbarSpy).subscribe({
      next: () => {
        expect(snackbarSpy).toHaveBeenCalledWith('Task completed successfully!', SnackBarType.success);
        expect(analyticsMock.trackEvent).toHaveBeenCalledOnceWith('crawl_completed', { taskId: 'task-1' });
        done();
      },
    });
  });

  it('should show an error snackbar when a task fails', (done) => {
    const snackbarSpy = jasmine.createSpy('showSnackbar');
    crawlServiceMock.getTaskStatus.and.returnValue(
      of({ status: CrawlOperationStatus.FAILED, result: { status: 'Failed', message: 'bad crawl' } } as any),
    );

    service.getTaskStatusWithSnackbar('task-1', snackbarSpy).subscribe({
      next: () => {
        expect(snackbarSpy).toHaveBeenCalledWith('Task failed!', SnackBarType.error);
        expect(analyticsMock.trackEvent).toHaveBeenCalledOnceWith('crawl_failed', { taskId: 'task-1' });
        done();
      },
    });
  });
});
