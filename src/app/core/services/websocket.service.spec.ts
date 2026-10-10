import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { WebSocketService, TASK_POLL_INTERVAL_MS } from './websocket.service';
import { getTestProviders } from 'src/app/testing';
import { AuthService } from './auth.service';
import { CrawlAPIService } from './crawlapi.service';

describe('WebsocketService', () => {
  let service: WebSocketService;
  let authServiceMock: jasmine.SpyObj<AuthService>;
  let crawlApiMock: jasmine.SpyObj<CrawlAPIService>;

  /** One SSE frame, shaped exactly as `CrawlAPIService.getTaskStatus` emits it. */
  const frame = (status: string, message = '') => ({
    status,
    result: { status, message },
  });

  beforeEach(() => {
    authServiceMock = jasmine.createSpyObj('AuthService', [], {
      token: 'token-123',
    });
    crawlApiMock = jasmine.createSpyObj('CrawlAPIService', ['getTaskStatus']);
    crawlApiMock.getTaskStatus.and.returnValue(of(frame('In Progress')));

    TestBed.configureTestingModule({
      providers: [
        ...getTestProviders(),
        { provide: AuthService, useValue: authServiceMock },
        { provide: CrawlAPIService, useValue: crawlApiMock },
      ],
    });

    service = TestBed.inject(WebSocketService);
  });

  afterEach(() => service.disconnectTaskSocket());

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should start with an empty task status list', () => {
    expect(service.getTaskStatuses()).toEqual([]);
  });

  it('should not connect task tracking when task ids are empty', () => {
    const consoleSpy = jasmine.isSpy(console.error)
      ? (console.error as jasmine.Spy)
      : spyOn(console, 'error');

    service.connectAndTrackTasks([]);

    expect(consoleSpy).toHaveBeenCalledWith('No task IDs provided');
    expect(crawlApiMock.getTaskStatus).not.toHaveBeenCalled();
  });

  it('should expose current task statuses from internal subject', () => {
    const statuses = [{ task_id: 'task-1', status: 'COMPLETED', timestamp: 1 } as any];
    (service as any).taskStatusSubject.next(statuses);

    expect(service.getTaskStatuses()).toEqual(statuses);
  });

  it('should read status through the BFF rather than opening a socket', fakeAsync(() => {
    service.connectAndTrackTasks(['task-1']);
    tick(0);

    expect(crawlApiMock.getTaskStatus).toHaveBeenCalledWith('task-1');
    expect(service.getTaskStatuses()[0].task_id).toBe('task-1');
    // Pins the REMOVAL, not just the behaviour: the direct-to-crawlagent socket
    // carried the Firebase ID token in a query string and bypassed the BFF, so
    // its field must not come back.
    expect((service as any).taskSocket$).toBeUndefined();
    service.disconnectTaskSocket();
  }));

  it('should mark a terminal status as final', fakeAsync(() => {
    crawlApiMock.getTaskStatus.and.returnValue(of(frame('Completed')));

    service.connectAndTrackTasks(['task-1']);
    tick(0);

    expect(service.getTaskStatuses()[0].status).toBe('Completed');
    expect(service.getTaskStatuses()[0].final).toBe(true);
  }));

  it('should keep polling while a task is still running', fakeAsync(() => {
    service.connectAndTrackTasks(['task-1']);
    tick(0);
    const afterFirst = crawlApiMock.getTaskStatus.calls.count();

    tick(TASK_POLL_INTERVAL_MS);

    expect(crawlApiMock.getTaskStatus.calls.count()).toBeGreaterThan(afterFirst);
    expect((service as any).pollSubscription).not.toBeNull();
    service.disconnectTaskSocket();
  }));

  it('should stop polling once every tracked task is terminal', fakeAsync(() => {
    crawlApiMock.getTaskStatus.and.returnValue(of(frame('Failed')));

    service.connectAndTrackTasks(['task-1']);
    tick(0);
    const afterFirst = crawlApiMock.getTaskStatus.calls.count();

    tick(TASK_POLL_INTERVAL_MS * 3);

    expect(crawlApiMock.getTaskStatus.calls.count()).toBe(afterFirst);
  }));

  it('should drop a task whose read errors instead of reporting it failed', fakeAsync(() => {
    crawlApiMock.getTaskStatus.and.returnValue(throwError(() => new Error('boom')));

    service.connectAndTrackTasks(['task-1']);
    tick(0);

    // A transient HTTP error is not a job outcome. Inventing a `Failed` row here
    // would stop the poll on a job that is still running.
    expect(service.getTaskStatuses()).toEqual([]);
    service.disconnectTaskSocket();
  }));

  it('should clear the poll when disconnecting', fakeAsync(() => {
    service.connectAndTrackTasks(['task-1']);
    tick(0);

    service.disconnectTaskSocket();

    expect((service as any).pollSubscription).toBeNull();
  }));
});
