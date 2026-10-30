import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostBinding,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe, JsonPipe, NgClass } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { MatIcon } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { EMPTY, catchError, concat, switchMap, takeWhile, timer } from 'rxjs';
import {
  DocumentData,
  DocumentSnapshot,
  Timestamp,
  doc,
  getDoc,
  setDoc,
} from '@angular/fire/firestore';
import { CrawlAPIService } from 'src/app/core/services';
import { AuthzService } from 'src/app/core/services';
import { BucketStorageService } from 'src/app/core/services';
import { FirestoreService } from 'src/app/core/services';
import { LoadingDotsComponent } from 'src/app/core/components';
import { CrawlOperationStatus } from 'src/app/core/enum';
import { statusBadgeClass } from 'src/app/core/functions';
import { CrawlOperation, JobResult, Users, WorkerProvenance } from 'src/app/core/types';

/**
 * How often a running job is re-read.
 *
 * The same cadence the tools panel uses: this page is a viewer of work that runs
 * server-side, so the only question each read answers is "has more landed?".
 */
const JOB_POLL_MS = 2000;

/** The statuses after which nothing about the job can change. */
const JOB_TERMINAL: readonly CrawlOperationStatus[] = [
  CrawlOperationStatus.COMPLETED,
  CrawlOperationStatus.FAILED,
  CrawlOperationStatus.CANCELED,
];

/**
 * A timestamp as a `datetime-local` value, in LOCAL time.
 *
 * `toISOString()` would hand back UTC, and an input that silently means UTC
 * while the user reads it as their own clock is how a job runs an hour or five
 * off. `datetime-local` takes `YYYY-MM-DDTHH:mm` with no zone, which is exactly
 * what this builds.
 * @param {number} at Epoch millis.
 * @return {string} The input's value.
 */
const localInputValue = (at: number): string => {
  const when = new Date(at);
  const pad = (value: number): string => `${value}`.padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}`;
};

/**
 * One operation, in full: `/operations/:id`.
 *
 * Why this page exists
 * --------------------
 * The list shows a name, one target and a status. Everything that actually
 * describes a run -- every target, what each returned, the prompt, the ids --
 * lived only in the component that started it, so a finished job was a row
 * whose contents nobody could open. The list's row leads here now, and this
 * page reads the SAME two sources that produced it: the operation document and
 * `GET /api/job/:id/result`.
 *
 * What it deliberately does NOT show
 * ----------------------------------
 * Machines and browser sessions. Nothing on the run path records which worker,
 * machine or session served a target -- `webrainTool` resolves a worker
 * internally and reports nothing back -- so a section claiming to list them
 * would be an empty table pretending the question was answered. The identifiers
 * that DO exist are shown, and the absence is stated in one line, so the gap is
 * visible rather than silent.
 */
@Component({
  selector: 'app-operation-detail',
  imports: [
    DatePipe,
    DecimalPipe,
    JsonPipe,
    NgClass,
    MatIcon,
    LoadingDotsComponent,
    TranslateModule,
  ],
  templateUrl: './operation-detail.component.html',
  styleUrl: './operation-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OperationDetailComponent {
  @HostBinding('class') classes = 'grow';

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly firestore = inject(FirestoreService);
  private readonly crawl = inject(CrawlAPIService);
  private readonly authz = inject(AuthzService);
  private readonly storage = inject(BucketStorageService);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * Whether this caller may ACT on the run, as opposed to look at it.
   *
   * The route grants `crawl.read`, so an org `viewer` reaches this page -- and a
   * viewer holds no `crawl.execute`. Cancel and reschedule are execution
   * decisions that the server would refuse, so the buttons are withheld here
   * rather than offered and then 403'd.
   *
   * `true` while the capability is still resolving: this page was readable
   * before the route was relaxed and the conservative default is to keep the
   * controls exactly as they were, not to hide them behind a pending read.
   */
  readonly canRun = toSignal(this.authz.can$('crawl', 'execute'), {
    initialValue: true,
  });

  private readonly db = this.firestore.getInstanceDB('easyscrape');

  /** The row's id, from the route. */
  readonly id = this.route.snapshot.paramMap.get('id') ?? '';

  private readonly user = this.route.snapshot.data['user'] as Users | undefined;

  /** The operation document, and the job behind its `task_id`. */
  readonly operation = signal<CrawlOperation | null>(null);
  readonly job = signal<JobResult | null>(null);

  readonly loading = signal(true);
  /** An i18n key for a failed read; empty when there was none. */
  readonly error = signal('');
  readonly canceling = signal(false);

  /**
   * The badge classes for a status.
   *
   * Exposed for the template. `statusBadgeClass` is a pure lookup, so calling it
   * from the template costs a map access per change detection and never a
   * request; the stored `color` field this replaced was a second source of truth
   * that could disagree with the status right beside it.
   */
  protected readonly statusBadgeClass = statusBadgeClass;

  /**
   * Whether the run can still be stopped.
   *
   * Read from the JOB when there is one, because the job's status is derived on
   * every read while the stored row only moves when a worker settles it. A row
   * saying `In Progress` for a job that finished a minute ago is the normal
   * lag, and offering "cancel" on it would be a button that answers "already
   * finished".
   */
  readonly running = computed(() => {
    const status = this.job()?.status ?? this.operation()?.status;
    return status === CrawlOperationStatus.IN_PROGRESS ||
      status === CrawlOperationStatus.STARTED ||
      status === CrawlOperationStatus.PENDING;
  });

  /**
   * Whether this run is still only a PLAN.
   *
   * A `Scheduled` row is waiting for the dispatcher and a `Ready` row was saved
   * without an action, so neither has run. Those are the only two states where
   * changing the time means anything: once a job exists, its run has begun.
   */
  readonly planned = computed(() => {
    const operation = this.operation();
    if (!operation || operation.task_id) {
      return false;
    }
    return operation.status === CrawlOperationStatus.SCHEDULED ||
      operation.status === CrawlOperationStatus.READY;
  });

  /** The new time the user is proposing, as the `datetime-local` value. */
  readonly newTime = signal('');  /** An i18n key for a refused time; empty when there was none. */
  readonly timeError = signal('');
  readonly savingTime = signal(false);

  /** The rows to show: the job's targets when there is a job, else the request's. */
  readonly targets = computed(() => this.job()?.items ?? [])

  /**
   * The distinct modes this run used, in the order they appear.
   *
   * One operation can hold a SEQUENCE of tool runs (a serp, then a batch), and
   * the job record carries a single `tool` that cannot describe that. The modes
   * are therefore read off the units, which is the only place that knows which
   * tool produced which row.
   */
  readonly modes = computed(() =>
    [...new Set(
      this.targets()
        .map((item) => item.tool)
        .filter((tool): tool is string => !!tool),
    )],
  );

  /**
   * Every distinct worker the run touched.
   *
   * Read from the JOB, because that is where each target records what served it
   * -- a batch can span the pool, so the operation document cannot hold one
   * answer. Empty means nothing was reported: either the call never produced a
   * result, or the job predates the record.
   */
  readonly workers = computed(() => this.job()?.workers ?? []);

  /** The files stored from this run, and how many bytes they add up to. */
  readonly files = computed(() => this.operation()?.storage ?? []);

  readonly storageBytes = computed(() =>
    this.files().reduce(
      (total, file) => total + (file.metadata?.file_size ?? 0),
      0,
    ),
  );

  /**
   * When the run last changed, and how long it took.
   *
   * The job's own timestamp wins while it exists: the operation row is only
   * rewritten when a worker settles it, and `metrics.duration` is written by a
   * runtime this platform no longer uses, so it is the fallback rather than the
   * first answer.
   */
  readonly updatedAt = computed(() => {
    const job = this.job();
    if (job?.updated_at) {
      return job.updated_at;
    }
    return this.operation()?.updated_At;
  });

  readonly durationSeconds = computed(() => {
    const recorded = this.operation()?.metrics?.duration;
    if (typeof recorded === 'number' && recorded > 0) {
      return recorded;
    }
    const created = this.operation()?.created_At;
    const updated = this.updatedAt();
    if (!created || !updated || updated < created) {
      return null;
    }
    return Math.round((updated - created) / 1000);
  });

  /**
   * What the run reported, at the three levels it can report at.
   *
   * Built from fields that exist rather than from a log store: the operation's
   * own `error`, the job's summary message, and each target's failure or
   * challenge. A real log level (and a store behind it) is a settings-driven
   * feature, so this deliberately does not pretend to be one.
   */
  readonly messages = computed(() => {
    const entries: Array<{
      level: 'info' | 'warning' | 'error'
      label: string
      text: string
    }> = [];
    const operation = this.operation();
    const job = this.job();

    if (operation?.error) {
      entries.push({ level: 'error', label: operation.name, text: operation.error });
    }
    if (job?.message) {
      entries.push({ level: 'info', label: '', text: job.message });
    }
    for (const item of job?.items ?? []) {
      if (item.status === 'error' && item.message) {
        entries.push({ level: 'error', label: item.label, text: item.message });
      }
      if (item.challenge) {
        entries.push({ level: 'warning', label: item.label, text: item.challenge });
      }
    }

    return entries;
  });

  constructor() {
    void this.load();
  }

  /**
   * Read the operation, then start watching its job.
   *
   * Sequential on purpose: `task_id` comes from THIS document, so there is
   * nothing to poll until it has been read.
   * @return {Promise<void>} Resolves once the document has settled.
   */
  private async load(): Promise<void> {
    const uid = this.user?.uid;

    if (!uid || !this.id) {
      this.error.set('OPERATION_DETAIL.NOT_FOUND');
      this.loading.set(false);
      return;
    }

    try {
      const snapshot = await getDoc(
        doc(this.db, `users/${uid}/operations/${this.id}`),
      );

      if (!snapshot.exists()) {
        this.error.set('OPERATION_DETAIL.NOT_FOUND');
        return;
      }

      this.operation.set(this.mapOperation(snapshot));
      // The picker opens on the time already chosen, not on "now": a reschedule
      // is a nudge, and retyping the whole date every time is the difference
      // between editing a plan and rebuilding it.
      const planned = this.mapOperation(snapshot).scheduled_At;
      this.newTime.set(
        localInputValue(
          typeof planned === 'number' && planned > 0 ?
            planned :
            Date.now() + 3_600_000,
        ),
      );
    } catch (failure) {
      console.error('Error reading the operation:', failure);
      this.error.set('OPERATIONS.RESULTS_ERROR');
    } finally {
      this.loading.set(false);
    }

    this.watchJob();
  }

  /**
   * Follow the job while it runs, and stop when it settles.
   *
   * A failed read does not blank the page: the operation document is still a
   * real answer, and replacing it with an error because the JOB endpoint
   * hiccuped would throw away what is on screen.
   * @return {void}
   */
  private watchJob(): void {
    const taskId = this.operation()?.task_id;

    if (!taskId) {
      return;
    }

    concat(
      this.crawl.getJobResult(taskId),
      timer(JOB_POLL_MS, JOB_POLL_MS).pipe(
        switchMap(() => this.crawl.getJobResult(taskId)),
      ),
    ).pipe(
      catchError(() => EMPTY),
      takeWhile((result) => !JOB_TERMINAL.includes(result.status), true),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((result) => {
      this.job.set(result);
      // The header follows the job, not the stored row: the row is only
      // rewritten when a worker settles it.
      this.operation.update((operation) =>
        operation ? { ...operation, status: result.status } : operation,
      );
    });
  }

  /**
   * Keep this run's result in the caller's own storage.
   *
   * Why this is here at all: a tool result lives in the JOB document, and the
   * artifacts a worker mentions are bare filenames on the worker's own disk --
   * there was no way to file a run's output anywhere the caller could keep it.
   * `POST /api/storage/payload` now takes the bytes directly (the shared cache
   * is URL-keyed, and a payload has no url), so the whole job is filed under a
   * name derived from the operation.
   *
   * `savedKey` is set from the REPLY rather than assumed, and that is what the
   * button reports: a save that was refused (`storage.write` is self-only, so an
   * org viewer is refused) must not look like one that worked.
   */
  readonly savingResult = signal(false);
  readonly savedKey = signal('');

  /**
   * File the current job as JSON.
   *
   * @return {void}
   */
  /** Whether a "Run now" is in flight, so a second press is ignored. */
  readonly starting = signal(false);

  /**
   * Start a planned row now, instead of waiting for its time.
   *
   * The same two enqueue routes a playground run uses -- no route was added for
   * "run this stored row". The server writes the row back itself, keyed by the
   * id it was sent, so the plan becomes a job in place rather than a second
   * entry beside it.
   * @return {void}
   */
  protected runNow(): void {
    const operation = this.operation();
    if (!operation || this.starting()) {
      return;
    }

    const request =
      operation.tool && operation.args ?
        this.crawl.enqueueTool(operation.tool, operation.args, operation) :
        this.crawl.multiCrawlEnqueue(operation.urls ?? [], operation);

    this.starting.set(true);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (task) => {
        this.starting.set(false);
        this.operation.update((current) =>
          current ?
            {
              ...current,
              task_id: task.id,
              status: CrawlOperationStatus.IN_PROGRESS,
            } :
            current,
        );
      },
      error: (failure: unknown) => {
        console.error('Error starting the operation:', failure);
        this.starting.set(false);
      },
    });
  }

  protected saveResult(): void {
    const job = this.job();
    const operation = this.operation();

    if (!job || this.savingResult()) {
      return;
    }

    const name = `${operation?.name || 'operation'}-${this.id}.json`;
    const content = JSON.stringify({operation, job}, null, 2);

    this.savingResult.set(true);
    this.storage
      .savePayload(content, name.replace(/[^A-Za-z0-9._-]+/g, '_'))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (reply) => {
          this.savingResult.set(false);
          this.savedKey.set(reply.key);
        },
        error: (failure: unknown) => {
          console.error('Error saving the operation result:', failure);
          this.savingResult.set(false);
        },
      });
  }

  /**
   * Stop the run.
   *
   * The server records the decision and each delivery checks it before doing
   * any work, so this is a request that takes effect per remaining target
   * rather than an abort -- which is why the reply, not the click, sets the
   * status.
   * @return {void}
   */
  protected cancel(): void {
    const taskId = this.operation()?.task_id;

    if (!taskId || this.canceling()) {
      return;
    }

    this.canceling.set(true);
    this.crawl.cancelTask(taskId).subscribe({
      next: () => {
        this.canceling.set(false);
        this.operation.update((operation) =>
          operation ?
            { ...operation, status: CrawlOperationStatus.CANCELED } :
            operation,
        );
      },
      error: (failure: unknown) => {
        console.error('Error canceling the operation:', failure);
        this.canceling.set(false);
      },
    });
  }

  /**
   * Move a planned run to a new time.
   *
   * Written straight to the operation document, which the owner's own rules
   * allow, and read by `runDueOperations` when the time comes — there is no
   * route to add for "change a number on my own row". The row is set back to
   * `Scheduled` because a `Ready` row with a time is a plan the dispatcher would
   * otherwise still ignore.
   *
   * A time that has already passed is refused rather than saved: the dispatcher
   * would run it on its next tick, which means "schedule for yesterday" would
   * silently start work immediately.
   * @return {Promise<void>} Resolves once the write has settled.
   */
  protected async reschedule(): Promise<void> {
    const operation = this.operation();
    const at = new Date(this.newTime()).getTime();

    this.timeError.set('');

    if (!operation) {
      return;
    }
    if (!this.newTime() || Number.isNaN(at)) {
      this.timeError.set('OPERATION_DETAIL.ERR_TIME_REQUIRED');
      return;
    }
    if (at <= Date.now()) {
      this.timeError.set('OPERATION_DETAIL.ERR_TIME_PAST');
      return;
    }

    this.savingTime.set(true);
    try {
      await setDoc(
        doc(this.db, `users/${this.user?.uid}/operations/${operation.id}`),
        { scheduled_At: at, status: CrawlOperationStatus.SCHEDULED },
        { merge: true },
      );
      this.operation.update((current) =>
        current ?
          {
            ...current,
            scheduled_At: at,
            status: CrawlOperationStatus.SCHEDULED,
          } :
          current,
      );
    } catch (failure) {
      console.error('Error rescheduling the operation:', failure);
      this.timeError.set('OPERATIONS.RESULTS_ERROR');
    } finally {
      this.savingTime.set(false);
    }
  }

  /**
   * Drop a planned run without running it.
   *
   * `Canceled`, not a delete: the row stays in the list with the reason it never
   * ran, which is the difference between "I stopped this" and "this vanished".
   * @return {Promise<void>} Resolves once the write has settled.
   */
  protected async stopPlanned(): Promise<void> {
    const operation = this.operation();

    if (!operation?.id) {
      return;
    }

    this.savingTime.set(true);
    try {
      await setDoc(
        doc(this.db, `users/${this.user?.uid}/operations/${operation.id}`),
        { status: CrawlOperationStatus.CANCELED },
        { merge: true },
      );
      this.operation.update((current) =>
        current ?
          { ...current, status: CrawlOperationStatus.CANCELED } :
          current,
      );
    } catch (failure) {
      console.error('Error stopping the planned operation:', failure);
      this.timeError.set('OPERATIONS.RESULTS_ERROR');
    } finally {
      this.savingTime.set(false);
    }
  }

  /**
   * The material icon for a worker kind.
   *
   * Icons rather than only words because the three arrangements are what a user
   * scans for: their own machine, a private worker, a shared one.
   * @param {WorkerProvenance['kind']} kind The reported kind.
   * @return {string} A `mat-icon` name.
   */
  protected workerIcon(kind: WorkerProvenance['kind']): string {
    switch (kind) {
      case 'own-machine':
        return 'computer';
      case 'leased':
        return 'lock';
      default:
        return 'groups';
    }
  }

  /**
   * The i18n key naming a worker kind.
   * @param {WorkerProvenance['kind']} kind The reported kind.
   * @return {string} The key the template translates.
   */
  protected workerLabelKey(kind: WorkerProvenance['kind']): string {
    switch (kind) {
      case 'own-machine':
        return 'OPERATION_DETAIL.KIND_OWN';
      case 'leased':
        return 'OPERATION_DETAIL.KIND_LEASED';
      default:
        return 'OPERATION_DETAIL.KIND_SHARED';
    }
  }

  /**
   * The i18n key naming a message level.
   * @param {'info' | 'warning' | 'error'} level The entry's level.
   * @return {string} The key the template translates.
   */
  protected levelKey(level: 'info' | 'warning' | 'error'): string {
    return `OPERATION_DETAIL.LEVEL_${level.toUpperCase()}`;
  }

  /**
   * Back to the list, one segment up.
   *
   * Derived from the CURRENT url rather than `routerLink="/operations"`,
   * because `appPageRoutes` is mounted in both the bare tree and the
   * `/{orgId}` tree: an absolute link would drop the org prefix for every
   * org-scoped user.
   * @return {void}
   */
  protected back(): void {
    const segments = this.router.url.split('?')[0].split('/');
    segments.pop();
    void this.router.navigateByUrl(segments.join('/') || '/');
  }

  /**
   * The document as the type this app uses.
   *
   * `created_At` is a `Timestamp` on anything written by the server and a
   * number on anything written by the client, so it is normalised once here
   * instead of at every binding site.
   * @param {DocumentSnapshot<DocumentData>} snapshot The operation document.
   * @return {CrawlOperation} The row, with a numeric timestamp.
   */
  private mapOperation(
    snapshot: DocumentSnapshot<DocumentData>,
  ): CrawlOperation {
    const data = snapshot.data() ?? {};
    const created = data['created_At'];

    return {
      ...(data as CrawlOperation),
      id: snapshot.id,
      created_At:
        created instanceof Timestamp ?
          created.toMillis() :
          typeof created === 'number' ?
            created :
            Date.now(),
    };
  }
}
