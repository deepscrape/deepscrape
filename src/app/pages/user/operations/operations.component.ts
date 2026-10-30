import { AsyncPipe, DatePipe, DecimalPipe, NgClass } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, HostBinding, SimpleChanges, ViewChild, computed, effect, inject, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { FormBuilder, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms'
import { FirestoreService } from 'src/app/core/services'
import { MatIcon } from '@angular/material/icon'
import { MatProgressBarModule } from '@angular/material/progress-bar'
import { MatProgressSpinner } from '@angular/material/progress-spinner'
import { RouterLink, Router, ActivatedRoute } from '@angular/router'
import { BehaviorSubject, combineLatest, debounceTime, distinctUntilChanged, map, Observable, of, Subject, Subscription, takeUntil, tap, timer } from 'rxjs'
import { DropdownComponent, GinputComponent, LoadingDotsComponent, PromptareaComponent, SnackBarType, StinputComponent } from 'src/app/core/components'
import { FeatureGateComponent } from 'src/app/core/components/feature-gate/feature-gate.component'
import {
  OPERATIONS_REQUIREMENT,
  gateStateFor,
} from 'src/app/core/components/feature-gate/feature-gate.policy'
import { TranslateModule, TranslateService } from '@ngx-translate/core'
import { Outsideclick, RippleDirective } from 'src/app/core/directives'
import { CrawlOperationStatus } from 'src/app/core/enum'
import { isArray, setOperationStatusList, statusBadgeClass } from 'src/app/core/functions'
import { FormControlPipe } from 'src/app/core/pipes'
import { AiModelsService, AuthService, AuthzService, BillingService, CacheService, CrawlAPIService, CrawlStoreService, ScrollService, SnackbarService, TaskStatus, WebSocketService } from 'src/app/core/services'
import { AIModel, CrawlConfig, CrawlOperation, CrawlPack, CrawlTask, DropDownOption, JobResult, Users } from 'src/app/core/types'
import { MatInputModule } from '@angular/material/input'
import { MatFormFieldModule } from '@angular/material/form-field'
import { provideNativeDateAdapter } from '@angular/material/core'
import { MatDatepickerModule } from '@angular/material/datepicker'
import { MatTimepickerModule, provideNativeDateTimeAdapter } from '@dhutaryan/ngx-mat-timepicker'
import { UserInfo } from '@angular/fire/auth'
import { expandCollapseAnimation, listStaggerAnimation } from 'src/app/animations'
import {
  DocumentData,
  Firestore,
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
  where,
  writeBatch,
} from '@angular/fire/firestore'

type OperationPageCursor = {
  createdAt: number
  docId: string
}



@Component({
  selector: 'app-operations',
  imports: [DatePipe, RippleDirective, MatIcon, NgClass, AsyncPipe, MatProgressBarModule, LoadingDotsComponent, StinputComponent, FormControlPipe, GinputComponent, DropdownComponent, RouterLink, PromptareaComponent, ReactiveFormsModule, MatFormFieldModule, Outsideclick, MatProgressSpinner, MatInputModule, DecimalPipe, MatTimepickerModule, MatDatepickerModule, TranslateModule, FeatureGateComponent],
  providers: [provideNativeDateAdapter(), provideNativeDateTimeAdapter()],
  animations: [listStaggerAnimation, expandCollapseAnimation],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './operations.component.html',
  styleUrl: './operations.component.scss'
})
export class OperationsComponent {
  private readonly db: Firestore
  private readonly operationsSubject = new BehaviorSubject<CrawlOperation[] | null | undefined>(undefined)
  private readonly totalPagesSubject = new BehaviorSubject<number>(1)
  private readonly inTotalSubject = new BehaviorSubject<number>(0)
  private readonly pageCursorCacheNamespace = 'operations:lastDocByPage'



  private user: Users & { currProviderData: UserInfo | null } | null = null
  /* INPUT AND BUTS VARIABLES IN ACTION */
  @HostBinding('class') classes = 'grow';
  @ViewChild("searchBar") searchBar!: ElementRef

  url: FormControl<string>
  modelAI: FormControl<AIModel>

  private readonly aiModels = inject(AiModelsService)

  /**
   * The models this picker offers.
   *
   * Owned by `AiModelsService` because three pickers share this list and must agree on it: the
   * value here decides whose model the batch is submitted to. It fills in two passes (the static
   * list, then each vendor's live catalogue), so it is a signal -- a plain array mutated after the
   * first render never reaches an OnPush template.
   */
  readonly models = this.aiModels.models

  crawlPack: FormControl<DropDownOption | null>

  // retrieves data dynamically from server
  crawlConfigPack: DropDownOption[] = []

  /**
   * The pack each picker option stands for, keyed by that option's `code`.
   *
   * `DropDownOption` carries only a label and a code, and `multiCrawlEnqueue`
   * needs the whole pack because it spreads `config.value` into the request
   * body. Keeping the loaded packs beside their options avoids a second read on
   * submit. `code` is the pack document id, which is what the picker round-trips.
   */
  private readonly packsByCode = new Map<string, CrawlPack>()

  userprompt: FormControl<string>
  submitButton: FormControl<boolean>
  operationName: FormControl<string>

  operationStatus: FormControl<DropDownOption>
  operStatusList: DropDownOption[] = []

  loadingOperList: boolean = false

  datePick: FormControl<Date | null>
  minDate: Date
  timePick: FormControl<Date | null>

  minTime: Date
  addScrapperBtn: boolean

  protected operations$: Observable<CrawlOperation[] | null | undefined>
  protected totalOpePages$: Observable<number>
  protected inTotal$: Observable<number>

  // deletedCount = 4
  // canceledCount = 6

  // failedCount = 6



  // scheduledCount = 6

  // processingCount = 3

  // notStartedCount = 2

  // savedResultsCount = 2


  // urlsUsedCount = 10


  // statusColor: string


  protected operationsForm: FormGroup

  /**
   * The badge classes for a status, for the template.
   *
   * The row used to render `'operation-' + operation.color`, where `color` was a
   * colour NAME stored on the document. A row written by the server carries a
   * hex default (`#64748b`), which produced `operation-#64748b` -- a class that
   * does not exist, so the badge rendered with no background at all. Driving the
   * tone from the STATUS removes the second source of truth that could disagree
   * with the word printed inside the badge.
   */
  protected readonly statusBadgeClass = statusBadgeClass

  private destroy$ = new Subject<void>()
  private crawlSubs: Subscription
  private pagesSubs: Subscription
  private timerSubs: Subscription

  protected totalOperPerPage: number

  protected currentOpePage: number = 1
  protected operOptions: { menu_visible: boolean, id: string }[] = []

  protected isOperOptionsLoading: boolean
  private taskStatuses: TaskStatus[] = []
  private _seenTaskIds: Set<string> = new Set<string>()

  private readonly authz = inject(AuthzService)
  private readonly billing = inject(BillingService)

  /**
   * What this surface needs, from the same table the playground reads:
   * `POST /api/crawl/stream/job` carries `requirePaidAccess` plus
   * `requirePermission('crawl', 'execute')`, so the form is refused here instead of
   * surfacing a 402 after an operation has already been queued.
   *
   * `null` while either source is still resolving, and the template reads that as
   * allowed. Nothing on this page was gated before, so an unresolved entitlement must
   * not lock it: the conservative default is the current behaviour, not a refusal.
   */
  private readonly runSurface = toSignal(
    combineLatest([
      this.authz.can$('crawl', 'execute'),
      this.billing.canAccessPaidFeatures$(),
    ]).pipe(
      map(([canExecute, paid]) => ({ permissions: { crawl: canExecute }, paid })),
    ),
    { initialValue: null },
  )

  protected readonly operationsGate = computed(() => {
    const caps = this.runSurface()
    return caps ? gateStateFor(OPERATIONS_REQUIREMENT, caps) : null
  })

  protected readonly canRunOperations = computed(() => this.operationsGate()?.allowed ?? true)

  /**
   * Navigation for a row.
   *
   * The id is PUSHED onto this page's own url rather than built from an
   * absolute `/operations/:id`: `appPageRoutes` is mounted in both the bare tree
   * and the `/{orgId}` tree, so an absolute path would drop the org prefix for
   * every org-scoped user.
   */
  private readonly router = inject(Router)

  /**
   * Which row is expanded, and what has been read for every row ever opened.
   *
   * ONE id, not a set: the box is an accordion, so opening a row is also the
   * act of closing the previous one -- a signal makes that a single write and
   * the animation follows the state on its own.
   *
   * The read results are kept for rows that have since COLLAPSED. Dropping them
   * with the id would empty the panel in the same change-detection pass that
   * starts the collapse, so the box would snap shut instead of animating. A
   * `null` value means "opened, still reading".
   */
  protected readonly openId = signal<string | null>(null)
  protected readonly openResults = signal<Record<string, JobResult | null>>({})
  /** The ids whose read failed, so a row can say so instead of showing nothing. */
  protected readonly openErrors = signal<Record<string, boolean>>({})
  /** The row whose cancel is in flight, so a second press is ignored. */
  protected readonly cancelingId = signal<string | null>(null)

  /**
   * Fold a row open, or shut if it is the open one.
   *
   * The job is read ONCE per row and cached: this is a peek at what a run
   * produced, not a live view -- the detail page follows a running job, and
   * re-reading here on every toggle would only repeat a document.
   * @param {CrawlOperation} operation The row that was clicked.
   * @return {void}
   */
  protected toggleOperation(operation: CrawlOperation): void {
    const id = operation.id

    if (!id)
      return

    if (this.openId() === id) {
      this.openId.set(null)
      return
    }

    this.openId.set(id)

    const taskId = operation.task_id
    if (!taskId || id in this.openResults())
      return

    this.openResults.update((rows) => ({ ...rows, [id]: null }))
    this.crawlService.getJobResult(taskId).subscribe({
      next: (result) => this.openResults.update((rows) => ({ ...rows, [id]: result })),
      error: (failure: unknown) => {
        console.error('Error reading job results:', failure)
        // The row keeps saying "reading" only while a read is in flight, so a
        // failure has to remove the placeholder rather than leave it there.
        this.openResults.update((rows) => {
          const next = { ...rows }
          delete next[id]
          return next
        })
        this.openErrors.update((errors) => ({ ...errors, [id]: true }))
      },
    })
  }

  /**
   * Whether this run can still be stopped.
   *
   * Read from the JOB, not the stored row: the row is only rewritten when a
   * worker settles it, so offering "cancel" on a finished job is a button that
   * answers "already finished".
   * @param {JobResult | null} result The job that was read for this row.
   * @return {boolean} True while it is still running.
   */
  protected isLive(result: JobResult | null): boolean {
    const status = result?.status
    return status === CrawlOperationStatus.IN_PROGRESS ||
      status === CrawlOperationStatus.STARTED
  }

  /**
   * Stop a run from the list.
   *
   * The server records the decision and every remaining delivery checks it, so
   * the local status is set from the REPLY and the list is refreshed rather than
   * assumed stopped.
   * @param {CrawlOperation} operation The row whose run should stop.
   * @return {void}
   */
  protected cancelOperation(operation: CrawlOperation): void {
    const taskId = operation.task_id
    const id = operation.id

    if (!taskId || !id || this.cancelingId() === id)
      return

    this.cancelingId.set(id)
    this.crawlService.cancelTask(taskId).subscribe({
      next: () => {
        this.cancelingId.set(null)
        // The peek keeps its rows, so its status has to move with the cancel or
        // it keeps offering a button for a run that has stopped.
        this.openResults.update((rows) => {
          const found = rows[id]
          return found ?
            { ...rows, [id]: { ...found, status: CrawlOperationStatus.CANCELED } } :
            rows
        })
        this.refreshOperationList()
      },
      error: (failure: unknown) => {
        console.error('Error canceling the operation:', failure)
        this.cancelingId.set(null)
      },
    })
  }

  /**
   * The rows worth showing in the peek: five at most.
   *
   * A crawl batch can land fifty targets, and the box is inside the list -- the
   * full set is what the detail page is for. `rest` is what is left over, so
   * the panel can say how many without pretending they are shown.
   * @param {JobResult | null | undefined} result The job, when it has landed.
   * @return {{shown: JobResult['items'], rest: number}} The slice to render.
   */
  protected peek(result: JobResult | null | undefined): { shown: JobResult['items'], rest: number } {
    const items = result?.items ?? []
    return { shown: items.slice(0, 5), rest: Math.max(0, items.length - 5) }
  }

  /**
   * Whether this row is the expanded one.
   *
   * `CrawlOperation.id` is optional, and a template cannot index a record with
   * `string | undefined`, so the three lookups the panel needs are methods.
   * @param {string | undefined} id The row id.
   * @return {boolean} True when its box is open.
   */
  protected isOpen(id: string | undefined): boolean {
    return id !== undefined && this.openId() === id
  }

  /**
   * What has been read for a row, or `undefined` when nothing has.
   * @param {string | undefined} id The row id.
   * @return {JobResult | null | undefined} The job, `null` while reading.
   */
  protected resultFor(id: string | undefined): JobResult | null | undefined {
    return id !== undefined ? this.openResults()[id] : undefined
  }

  /**
   * Whether the read for a row failed.
   * @param {string | undefined} id The row id.
   * @return {boolean} True when the last read failed.
   */
  protected failedFor(id: string | undefined): boolean {
    return id !== undefined && this.openErrors()[id] === true
  }

  constructor(
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef,
    private fb: FormBuilder,
    private firestoreService: FirestoreService,
    private cacheService: CacheService,
    private authService: AuthService,
    private crawlStoreService: CrawlStoreService,
    private crawlService: CrawlAPIService,
    private snackbarService: SnackbarService,
    private scroll: ScrollService,
    private translate: TranslateService,
    private wsService: WebSocketService
  ) {
    this.db = this.firestoreService.getInstanceDB('easyscrape')
    this.initVariables()
    this.initFormBuilders()
    this.initOperations()


  }

  private initVariables() {

    this.user = this.route.snapshot.data['user'];

    this.addScrapperBtn = false

    this.url = new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
      ]
    },)

    this.modelAI = new FormControl<DropDownOption>({ name: 'claude-haiku-5-5', code: "claude" }, {
      // updateOn: 'blur', //default will be change
      nonNullable: true,
      validators: [
        Validators.required,
        // forbiddenNameValidator(/^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,6}(\/[^\s]*)?$/i)
      ]
    })

    // Fills the list, then repairs the selection whenever the list moves. Both are needed: the
    // list arrives in two passes, and a control whose value is not among its options renders with
    // NOTHING selected. The control is built here rather than as a field initializer, so the first
    // pass of this effect can run before it exists.
    this.aiModels.load()
    effect(() => {
      this.models()
      if (!this.modelAI) {
        return
      }
      this.modelAI.setValue(this.aiModels.selectionFor(this.modelAI.value), { emitEvent: false })
    })

    this.crawlPack = new FormControl<DropDownOption | null>(null, {
      // updateOn: 'blur', //default will be change
      nonNullable: false,
      validators: [
        // Validators.required,
        // forbiddenNameValidator(/^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,6}(\/[^\s]*)?$/i)
      ]
    })
    // { name: 'CrawlConfig2', code: "crawlpack-track-id-2" }, { name: 'CrawlConfig3', code: "crawlpack-track-id-3" }
    // this.crawlConfigPack.push()

    /* 
      Prompt Form 
     */

    this.operationStatus = new FormControl<DropDownOption>({
      name: 'COMMON.SAVE',
      code: CrawlOperationStatus.READY
    }, {
      // updateOn: 'blur', //default will be change
      nonNullable: true,
      validators: [
        Validators.required,
        // forbiddenNameValidator(/^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,6}(\/[^\s]*)?$/i)
      ]
    })

    setOperationStatusList(this.operStatusList)

    // Action option names are i18n key paths (app-dropdown pipes option.name);
    // codes stay enum literals because submit logic compares operationStatus.value.code.
    for (const option of this.operStatusList) {
      switch (option.code) {
        case CrawlOperationStatus.READY:
          option.name = 'COMMON.SAVE'
          break
        case CrawlOperationStatus.STARTED:
          option.name = 'OPERATIONS.ACT_RUN'
          break
        case CrawlOperationStatus.SCHEDULED:
          option.name = 'OPERATIONS.ACT_SCHEDULE'
          break
      }
    }

    this.userprompt = new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
      ]
    })

    this.submitButton = new FormControl<boolean>(false, {
      nonNullable: true,
      validators: [
        Validators.required
      ]
    })

    this.operationName = new FormControl<string>('', {
      nonNullable: true,
      validators: [
        Validators.required
      ]
    })

    this.datePick = new FormControl<Date | null>(null, {
      updateOn: 'blur', //default will be change
      nonNullable: false,
      validators: [
        Validators.required
      ]
    })

    this.timePick = new FormControl<Date | null>(null, {

      nonNullable: false,
      validators: [
        Validators.required,
      ]
    })
    const date = new Date()
    this.minDate = date

  }

  private initFormBuilders() {
    this.operationsForm = this.fb.group({
      search: ['', {
        validators: []
      }],
      filters: [''],
    })

    // The search box had NO subscriber: `search` was a control the template
    // rendered and nothing read, so typing filtered nothing while the FILTERS
    // button beside it had no handler at all. Both are wired below, against the
    // two index-free queries `browse()` documents.
    this.operationsForm.get('search')?.valueChanges
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        takeUntil(this.destroy$),
      )
      .subscribe((term) => void this.browse(term, this.statusFilter()))
  }

  /**
   * Whether the FILTERS popover is open.
   *
   * A signal rather than a plain boolean so the button and the row it reveals
   * move together under OnPush.
   */
  protected readonly filtersOpen = signal(false)

  /** The status the list is filtered to, or `null` for every status. */
  protected readonly statusFilter = signal<CrawlOperationStatus | null>(null)

  /**
   * A browse is IN PROGRESS or claimed: either a search term or a status filter.
   *
   * While one is set the list shows that result set instead of a page, because
   * a filtered list has no meaningful page arithmetic -- the pages belong to the
   * unfiltered ordering.
   */
  protected readonly browsing = computed(() =>
    this.browseTerm().length > 0 || this.statusFilter() !== null
  )

  /** The term last applied, so the header can say what is being shown. */
  protected readonly browseTerm = signal('')

  /** Rows from the last browse; `null` means "not browsing". */
  private readonly browseSubject = new BehaviorSubject<CrawlOperation[] | null>(null)

  protected readonly browseBusy = signal(false)

  /** The statuses the filter offers. The enum's own values are the labels, as
   * everywhere else on this page, so no new i18n keys are invented for them. */
  protected readonly statusChoices: CrawlOperationStatus[] = [
    CrawlOperationStatus.SCHEDULED,
    CrawlOperationStatus.IN_PROGRESS,
    CrawlOperationStatus.COMPLETED,
    CrawlOperationStatus.FAILED,
    CrawlOperationStatus.CANCELED,
  ]

  /**
   * How many rows one search or filter may return.
   *
   * A cap rather than full paging: a name search is answered by a single-field
   * range query (no composite index to deploy) and 50 rows is more than a person
   * scrolls for a name they half-remember.
   */
  private readonly BROWSE_LIMIT = 50

  /**
   * Fold the browse result into the one stream the template iterates.
   *
   * `null` in the subject means "no browse is active", so the paged list passes
   * through untouched. One binding in the template instead of two lists keeps
   * the row markup -- and everything hanging off a row -- in one place.
   */
  protected list$!: Observable<CrawlOperation[] | null | undefined>

  /**
   * Show or hide the status chips.
   * @return {void}
   */
  protected toggleFilters(): void {
    this.filtersOpen.update((open) => !open)
  }

  /**
   * Apply one status filter, or clear it with `null`.
   *
   * Clears the search box, because a name range plus a status equality is a
   * COMPOSITE index -- and a query that 400s the whole list is worse than one
   * control at a time. `browse()` still honours both when they arrive together,
   * by filtering the second one in memory.
   * @param {CrawlOperationStatus | null} status The status, or null for all.
   * @return {void}
   */
  protected setStatusFilter(status: CrawlOperationStatus | null): void {
    this.statusFilter.set(status)
    void this.browse(this.browseTerm(), status)
  }

  /**
   * Drop the browse and go back to the paged list.
   * @return {void}
   */
  protected clearBrowse(): void {
    this.statusFilter.set(null)
    this.browseTerm.set('')
    this.operationsForm.get('search')?.setValue('', { emitEvent: false })
    this.browseSubject.next(null)
    this.cdr.markForCheck()
  }

  /**
   * One index-free query for a search term and/or a status.
   *
   * What this deliberately does NOT do is build a single Firestore query out of
   * both predicates. A range on `name` ordered by `name` plus an equality on
   * `status` needs a composite index, and a missing index fails the WHOLE read
   * with a 400 -- so the list would go blank for everyone until a deploy landed.
   * The name range is the query and the status is applied to its rows in memory;
   * the other order (status equality first) is what `setStatusFilter` uses when
   * no term is present.
   *
   * Sorting is in memory for the same reason: `orderBy('created_At')` on top of
   * an equality filter is the same composite index in a different shape.
   * @param {string} rawTerm What the user typed.
   * @param {CrawlOperationStatus | null} status The status filter, if any.
   * @return {Promise<void>} Resolves once the result is in `browseSubject`.
   */
  private async browse(
    rawTerm: string,
    status: CrawlOperationStatus | null,
  ): Promise<void> {
    const uid = this.user?.uid
    const term = rawTerm.trim()
    this.browseTerm.set(term)

    if (!uid || (!term && !status)) {
      this.browseSubject.next(null)
      this.cdr.markForCheck()
      return
    }

    this.browseBusy.set(true)
    this.cdr.markForCheck()

    try {
      const operationsRef = collection(this.db, `users/${uid}/operations`)
      const snapshot = term
        ? await getDocs(query(
          operationsRef,
          where('name', '>=', term),
          where('name', '<=', `${term}\uf8ff`),
          orderBy('name'),
          limit(this.BROWSE_LIMIT),
        ))
        : await getDocs(query(
          operationsRef,
          where('status', '==', status),
          limit(this.BROWSE_LIMIT),
        ))

      const rows = snapshot.docs
        .map((operationDoc) => this.mapOperationDoc(operationDoc))
        .filter((row) => !status || !term || row.status === status)
        .sort((a, b) => (b.created_At ?? 0) - (a.created_At ?? 0))

      this.browseSubject.next(rows)
    } catch (error) {
      // An empty result is a legitimate answer and a failed read is not, so the
      // failure clears the browse rather than pretending nothing matched.
      console.error('Error searching Crawl Operations:', error)
      this.showSnackbar(
        this.translate.instant('OPERATIONS.ERROR_LOAD'),
        SnackBarType.error,
        '',
        5000,
      )
      this.browseSubject.next(null)
      this.browseTerm.set('')
    } finally {
      this.browseBusy.set(false)
      this.cdr.markForCheck()
    }
  }

  private padZero(value: number): string {
    return value < 10 ? `0${value}` : `${value}`
  }
  protected get search() {
    return this.operationsForm.get('search')
  }
  initOperations() {

    // Subscribe to task status updates
    this.wsService.taskStatus$
      .subscribe(
        statuses => {
          this.taskStatuses = statuses;

          // Track new non-final statuses for one-time refresh
          if (!this._seenTaskIds) this._seenTaskIds = new Set<string>();
          let shouldRefresh = false;

          for (const s of statuses) {
            if (!s.final && !this._seenTaskIds.has(s.task_id)) {
              this._seenTaskIds.add(s.task_id);
              shouldRefresh = true;
            }
          }

          if (shouldRefresh) {
            this.refreshOperationList()
          }

          // At the end, if all statuses are final, refresh
          if (statuses.length > 0 && statuses.every(s => s.final)) {
            this.refreshOperationList()
            // Optionally clear seenTaskIds for next batch
            this._seenTaskIds.clear()
          }
        }
      )


    // Combine operations$ and taskStatus$
    this.operations$ = combineLatest([
      this.operationsSubject.asObservable(),
      this.wsService.taskStatus$
    ]).pipe(
      map(([operations, statuses]) => {
        if (!operations) return operations;
        // Map each operation and update its status if found in statuses
        return operations.map((op: CrawlOperation) => {
          const taskStatus = statuses.find((ts: any) => ts.task_id === op.task_id);
          if (taskStatus) {
            return {
              ...op,
              status: taskStatus.status as CrawlOperationStatus,
            }
          }
          return op
        })
      }),
      tap((operations: CrawlOperation[] | null | undefined) => {
        if (!operations || operations.length === 0) {
          return
        }
        // Connect to websocket for active tasks
        const taskIds = operations
          .filter(op => op.status !== CrawlOperationStatus.COMPLETED &&
            op.status !== CrawlOperationStatus.FAILED &&
            op.status !== CrawlOperationStatus.CANCELED)
          .map(op => op.task_id)
          .filter((taskId): taskId is string => !!taskId) // Type guard to filter out undefined/null taskIds
        this.connectToTaskWebSocket(taskIds)
      }),
      map((operations) => operations)
    )

    this.totalOpePages$ = this.totalPagesSubject.asObservable()
    this.inTotal$ = this.inTotalSubject.asObservable()

    // One stream for the template: the browse result when a search or a status
    // filter is active, the paged list otherwise. Built HERE rather than as a
    // field initializer because it folds `operations$`, which is assigned above.
    this.list$ = combineLatest([this.operations$, this.browseSubject]).pipe(
      map(([page, hits]) => hits ?? page),
    )

    this.totalOperPerPage = 10 // set a default value and update it later based on the user selection or local storage
    this.isOperOptionsLoading = false

    // create a new array of n items
    for (let i = 0; i < this.totalOperPerPage; i++) {
      this.operOptions.push({
        menu_visible: false,
        id: `${i + 1}`,
      })
    }

    void this.loadOperationsPage(1, true)

    // The picker had no writer, so the "pick a pack, then Run" instruction this
    // template opens with could never be followed. Load the options with the list.
    void this.loadCrawlPacks()
  }

  // ngOnChanges(changes: SimpleChanges): void {
  //   if (changes['taskIds'] && !changes['taskIds'].firstChange) {
  //     this.connectToTaskWebSocket();
  //   }
  // }

  private connectToTaskWebSocket(taskIds: string[] | undefined): void {
    if (!taskIds || taskIds.length === 0)
      return

    this.wsService.connectAndTrackTasks(taskIds)
  }

  ngOnInit(): void {
    //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
    //Add 'implements OnInit' to the class.
  }

  protected refreshOperationList() {

    // loading Operation List
    this.loadingOperList = true

    void this.loadOperationsPage(this.currentOpePage, true)

    // scroll to the search bar target in the page
    if (this.searchBar.nativeElement)
      this.scroll.scrollToElement(this.searchBar.nativeElement as HTMLElement)

    // Keep the existing delayed-loading UX cadence
    this.timerSubs = timer(400).subscribe(() => {
      this.loadingOperList = false;
      this.cdr.markForCheck()
    })
  }

  private prepareCrawlOperation(operation: CrawlOperation) {

    // store the operation to firestore database
    this.crawlSubs = this.crawlStoreService.storeCrawlOperation(
      operation.author.uid,
      operation
    )
      .subscribe({
        next: (done) => {
          console.log('done', done)
        },
        error: (error) => {
          console.log('error', error)
        },
        complete: () => {
          this.enableForm()
          this.refreshOperationList()
        }
      })


  }

  /**
   * Fill the pack picker from the caller's own saved packs.
   *
   * `crawlConfigPack` previously had no writer at all, so the template's
   * `@if(!crawlConfigPack.length)` always took the empty branch and this surface
   * could never satisfy the "create a pack, then Run" instruction in its own
   * copy. Each option's `code` is the pack document id, which is what
   * `packsByCode` keys on to hand `multiCrawlEnqueue` a real pack.
   *
   * Failure is not fatal: an empty picker is what the template already renders,
   * and `onPromptSubmited` still refuses a Run that has no pack.
   *
   * @return {Promise<void>} Resolves once the picker has been filled.
   */
  private async loadCrawlPacks(): Promise<void> {
    const uid = this.user?.uid

    if (!uid)
      return

    try {
      const packs = await this.firestoreService.loadPreviousPacks(uid)

      this.packsByCode.clear()
      this.crawlConfigPack = (packs ?? []).map((pack: CrawlPack): DropDownOption => {
        this.packsByCode.set(pack.id, pack)
        return { name: pack.title, code: pack.id }
      })
    } catch (error) {
      console.error('Error loading crawl packs:', error)
    }

    this.cdr.markForCheck()
  }

  /**
   * Enqueue one operation on the job surface the entitlement table names.
   *
   * `OPERATIONS_REQUIREMENT` cites `POST /api/crawl/stream/job`, which is
   * `CrawlAPIService.multiCrawlEnqueue`. This surface never called it: submit
   * went straight to `storeCrawlOperation`, so an operation was a Firestore row
   * with no `task_id`.
   *
   * That field is the whole mechanism. `initOperations` derives each row's
   * status from `wsService.taskStatus$` by matching `op.task_id`, and opens a
   * websocket only for rows that carry one. A row stored without it is inert and
   * displays whatever status the form happened to write; attaching the id from
   * the reply is what makes the row live.
   *
   * Persistence happens in `complete`, not `next`, so that a job the server
   * refused does not leave a row behind claiming to be running.
   *
   * @param {CrawlOperation} operationData The validated operation to enqueue.
   */
  private enqueueCrawlOperation(operationData: CrawlOperation): void {

    this.crawlSubs = this.crawlService
      .multiCrawlEnqueue(operationData.urls, operationData)
      .subscribe({
        next: (task: CrawlTask) => {
          operationData.task_id = task.id
          // The chosen action fixes the stored status; later changes arrive via
          // `taskStatus$`, keyed on the id attached just above.
          operationData.status = CrawlOperationStatus.STARTED
        },
        error: (error: unknown) => {
          console.error('Error enqueuing crawl operation:', error)
          this.enableForm()
          this.showSnackbar(this.translate.instant('OPERATIONS.INVALID_INPUT'), SnackBarType.error, '', 5000)
        },
        complete: () => {
          this.prepareCrawlOperation(operationData)
        }
      })
  }



  /**
   * Open one operation on its own page.
   *
   * A row that can be opened is the whole point of the detail route: the list
   * shows a name and a status, while everything that describes the run -- every
   * target, what each returned, the prompt, the ids -- lives on that page.
   * @param {CrawlOperation} operation The row that was clicked.
   * @return {void}
   */
  protected openOperation(operation: CrawlOperation): void {
    if (!operation.id)
      return

    const base = this.router.url.split('?')[0].replace(/\/+$/, '')
    void this.router.navigateByUrl(`${base}/${operation.id}`)
  }

  /**
   * Whether a rendered value is an address.
   *
   * A crawl row's value is a url; a TOOL row's is a label (`spider · https://…`),
   * which is not linkable. Binding `null` rather than a bogus href is what lets
   * one template serve both without a second copy of the markup.
   * @param {string | string[]} value The row's first value.
   * @return {boolean} True when it can be used as an href.
   */
  protected isHttpUrl(value: string | string[]): boolean {
    return typeof value === 'string' && /^https?:\/\//i.test(value)
  }

  /**
   * The row's link, or `null` when its first value is not an address.
   *
   * `getOperation` answers an ARRAY for a single-target row (its `isArray` test
   * asks for MORE than one), so this unwraps first rather than testing the
   * array. A tool row's value is a label, and `href` on one was a link to a
   * string that is not an address.
   * @param {CrawlOperation} operation The row.
   * @return {string | null} A url to open, or nothing.
   */
  protected hrefFor(operation: CrawlOperation): string | null {
    const first = this.getOperation(operation)
    const value = Array.isArray(first) ? first[0] : first
    return this.isHttpUrl(value) ? value as string : null
  }

  getOperation(operation: CrawlOperation): string | string[] {
    return this.isArray(operation.urls) ? operation.urls[0] : operation.urls
  }


  // addOperation(data: CrawlOperation) {
  //   // this.operations.push(data)
  // }

  deleteOperation(operation: CrawlOperation, indexOption: number) {

    if (!operation.id)
      return

    if (operation.author.uid !== this.user?.uid)
      return

    this.isOperOptionsLoading = true

    const ownerId = operation.author.uid
    const operationId = operation.id

    const operationRef = doc(this.db, `users/${ownerId}/operations/${operationId}`)
    const operationMetricsRef = doc(this.db, `operation_metrics/${operationId}`)
    const batch = writeBatch(this.db)

    batch.set(operationMetricsRef, { deleted_At: Date.now(), softDelete: true }, { merge: true })
    batch.delete(operationRef)

    batch.commit()
      .then(async () => {
        this.showSnackbar(this.translate.instant('OPERATIONS.DELETE_SUCCESS'), SnackBarType.success, '', 5000)
        this.resetOperationsPaginationCache()
        await this.loadOperationsPage(this.currentOpePage, true)
      })
      .catch((error: any) => {
        console.log('error', error)
        this.showSnackbar(this.translate.instant('OPERATIONS.DELETE_ERROR'), SnackBarType.error, '', 5000)
      })
      .finally(() => {
        this.isOperOptionsLoading = false
        this.operOptions[indexOption].menu_visible = false
        this.cdr.markForCheck()
      })
  }


  toggleMenuVisible(event: Event, index: number) {
    /* const element = event.target as HTMLElement
    console.log(element, element.parentElement && element.parentElement.matches('button'), element.matches('button'))
    if (this.operOptions[index].menu_visible &&
      (element.parentElement && element.parentElement.matches('button') || element.matches('button')))
      return */

    // remove the menu visible from all the other options
    for (let i = 0; i < this.operOptions.length; i++) {
      if (i !== index) {
        this.operOptions[i].menu_visible = false
      }
    }

    this.operOptions[index].menu_visible = !this.operOptions[index].menu_visible
  }

  closeOptions(event: Event, index: number) {

    const element = event.target as HTMLElement

    if (this.operOptions[index].menu_visible &&
      (element.parentElement && element.parentElement.matches('button') || element.matches('button')))
      return

    if (!this.operOptions[index].menu_visible) return

    this.operOptions[index].menu_visible = false
    this
  }


  isArray(arr: string | string[]): boolean {

    return isArray(arr) && arr.length > 1
  }

  /* INPUT & BUTTONS ACTIONS */

  protected setDateTime() {
    if (!this.datePick.value) return

    console.log('setDateTime')
    const date = this.datePick.value
    const currentTime = new Date()

    // Check if the selected date is today
    if (date.getUTCFullYear() === currentTime.getUTCFullYear() &&
      date.getUTCMonth() === currentTime.getUTCMonth() &&
      date.getUTCDate() === currentTime.getUTCDate()) {
      // Set the minimum time to the current time
      this.minTime = currentTime
    } else {
      // Set the minimum time to 00:00 if the selected date is not today
      this.minTime = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    }

    // Set the time picker value to the current time
    this.timePick.setValue(currentTime)
  }

  protected setTime() {
    if (!this.timePick.value)
      return


    const selectedDate = this.timePick.value
    const today = new Date()

    // Check if the selected date is today
    const isToday = selectedDate.toDateString() === today.toDateString()

    console.log('isToday', isToday)
    // Set the minimum time if the selected date is today
    if (isToday) {
      this.minTime = today
    } else {
      // Set the minimum time to 00:00 if the selected date is not today
      this.minTime = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    }
  }

  protected onClearText() {
    this.operationName.setValue('')
    this.operationStatus.setValue(this.operationStatus.defaultValue)
    this.url.setValue('')
    this.userprompt.setValue('')
  }

  protected abortRequests() {

    // Emit a signal to cancel the request
    this.destroy$.next()
    // this.isResultsProcessing = this.isCrawlProcessing = false
    // this.enableForm()
    this.showSnackbar(this.translate.instant('OPERATIONS.REQUEST_CANCELED'), SnackBarType.info, '', 5000)
  }

  protected onPromptSubmited(prompt: string) {

    // return an error message if url or userpormpt is invalid
    if (!this.url.valid || !this.userprompt.valid
      || !this.modelAI.valid || !this.operationName.valid
      || (this.operationStatus.value.code === CrawlOperationStatus.SCHEDULED &&
        (!this.datePick.valid || !this.timePick.valid))) {
      this.showSnackbar(this.translate.instant('OPERATIONS.INVALID_INPUT'), SnackBarType.error, '', 5000)
      return
    }


    // Setup the crawl operation urls
    let URLs: string = this.url.value

    const arrURL: string[] = URLs.split(',')

    const scheduled_At = this.timePick.value?.getTime() || Date.now()

    // setup the crawl operation
    const operationData: CrawlOperation = {
      author: { uid: this.user?.uid || '', displayName: this.user?.currProviderData?.displayName || '' },
      modelAI: this.modelAI.value as AIModel,
      created_At: Date.now(),
      name: this.operationName.value,
      urls: arrURL,
      type: 'operation',
      prompt: this.userprompt.value, // 
      scheduled_At,  // 30 * 60 * 1000
      status: this.operationStatus.value.code as CrawlOperationStatus,
      // metadata: this.crawlPack.value,
      // metadata: {
      //   crawler: {
      //     waitUntil: 'networkidle',
      //   },
      //   browser: {
      //     cssSelector: '',
      //   }

      // }
    }

    // console.log(operationData)
    // this.addOperation(operationData)

    // reset the results
    // this.closeResults()

    // The action dropdown IS the "how" of job creation for this surface: Run
    // enqueues, Save and Schedule only record. Only the Save path was ever
    // implemented -- submit fell through to `storeCrawlOperation` for every
    // action, so Run and Schedule each wrote an inert row and nothing was ever
    // queued.
    const action = this.operationStatus.value.code as CrawlOperationStatus

    if (action !== CrawlOperationStatus.STARTED) {
      // disable the form
      this.disableForm()

      // Save records the operation; Schedule records it carrying `scheduled_At`
      // for a dispatcher to pick up later. Nothing enqueues a scheduled row yet,
      // so both actions are deliberately store-only rather than silently running.
      this.prepareCrawlOperation(operationData)
      return
    }

    // No crawl pack is required to Run. The job body is the URL list plus
    // `operation_data`; a pack's `crawler_config`/`browser_config` are Crawl4AI's
    // shape and the job route is served by webrain, which reads neither. Demanding
    // one blocked every fresh account -- packs can no longer be created -- and
    // changed nothing about the request when one was supplied.
    // disable the form
    this.disableForm()

    // enqueue the Crawl operation on the paid job surface
    this.enqueueCrawlOperation(operationData)
  }

  private enableForm() {

    this.url.enable()
    this.userprompt.enable()
    this.submitButton.setValue(false)
    this.modelAI.enable()
  }

  private disableForm() {
    this.url.disable()
    this.userprompt.disable()
    this.submitButton.setValue(true)
    this.modelAI.disable()
  }


  protected onDropDownSelected_Status($event: any) {
    // throw new Error('Method not implemented.')
    console.log($event)
  }
  protected onDropDownSelected($event: any) {
    // throw new Error('Method not implemented.')
  }

  protected onDataLinkChange(event: Event) {
    // const input = event.target as EventTarget & HTMLInputElement

    // go to the focus to the next text input, textarea
  }

  protected toggleScrapperBtn() {
    // Never open a form whose only submit path the backend refuses. Closing stays
    // allowed, so a caller whose access changed can still dismiss the form.
    if (!this.addScrapperBtn && !this.canRunOperations()) {
      return
    }

    this.addScrapperBtn = !this.addScrapperBtn
  }

  protected onPageChanged(page: number, totalOpePages: number) {

    // if the page is the same as the current page, return
    if (page == 1 && page == totalOpePages || (this.currentOpePage == page))
      return

    // set the currentOpePage
    this.currentOpePage = page

    void this.loadOperationsPage(this.currentOpePage)

    // scroll to the search bar target in the page
    this.scroll.scrollToElement(this.searchBar.nativeElement as HTMLElement)

  }


  getVisiblePageNumbers(totalPages: number): number[] {
    // When we have 7 or fewer pages, just return all pages
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    // For more than 7 pages, we'll show a sliding window of 5 pages
    let startPage = Math.max(2, this.currentOpePage - 2);
    let endPage = Math.min(totalPages - 1, this.currentOpePage + 2);

    // Adjust the window to always show 5 pages when possible
    if (this.currentOpePage <= 4) {
      endPage = 6;
    } else if (this.currentOpePage >= totalPages - 3) {
      startPage = totalPages - 5;
    }

    return Array.from(
      { length: endPage - startPage + 1 },
      (_, i) => startPage + i
    );
  }
  // 'info' | 'success' | 'warning' | 'error'
  private showSnackbar(
    message: string,
    type: SnackBarType = SnackBarType.info,
    action: string | '' = '',
    duration: number = 3000) {

    this.snackbarService.showSnackbar(message, type, action, duration)
  }

  private async loadOperationsPage(page: number, forceCountRefresh = false): Promise<void> {
    if (!this.user?.uid) {
      this.operationsSubject.next([])
      this.totalPagesSubject.next(1)
      this.inTotalSubject.next(0)
      this.currentOpePage = 1
      this.cdr.markForCheck()
      return
    }

    try {
      if (forceCountRefresh || this.inTotalSubject.value === 0) {
        const countSnap = await getCountFromServer(collection(this.db, `users/${this.user.uid}/operations`))
        const total = countSnap.data().count || 0
        this.inTotalSubject.next(total)
        this.totalPagesSubject.next(Math.max(1, Math.ceil(total / this.totalOperPerPage)))
      }

      const totalItems = this.inTotalSubject.value
      const totalPages = this.totalPagesSubject.value

      if (totalItems === 0) {
        this.currentOpePage = 1
        this.operationsSubject.next([])
        this.cdr.markForCheck()
        return
      }

      const safePage = Math.min(Math.max(page, 1), totalPages)
      const previousCursor = await this.getOperationsPageStartCursor(safePage)
      const operationsRef = collection(this.db, `users/${this.user.uid}/operations`)
      const operationsQuery = previousCursor
        ? query(
          operationsRef,
          orderBy('created_At', 'desc'),
          orderBy(documentId(), 'desc'),
          startAfter(previousCursor.createdAt, previousCursor.docId),
          limit(this.totalOperPerPage)
        )
        : query(operationsRef, orderBy('created_At', 'desc'), orderBy(documentId(), 'desc'), limit(this.totalOperPerPage))

      const operationsSnap = await getDocs(operationsQuery)
      const operations = operationsSnap.docs.map((operationDoc) => this.mapOperationDoc(operationDoc))

      this.currentOpePage = safePage
      this.operationsSubject.next(operations)

      const pageLastDoc = operationsSnap.empty ? null : operationsSnap.docs[operationsSnap.docs.length - 1]
      const pageCursor = this.toOperationsPageCursor(pageLastDoc)
      this.cacheService.set<number, OperationPageCursor | null>(this.pageCursorCacheNamespace, this.currentOpePage, pageCursor)
    } catch (error) {
      console.error('Error retrieving Crawl Operations:', error)
      this.operationsSubject.next(null)
      this.totalPagesSubject.next(0)
      this.inTotalSubject.next(0)
    } finally {
      this.cdr.markForCheck()
    }
  }

  private async getOperationsPageStartCursor(targetPage: number): Promise<OperationPageCursor | null> {
    if (targetPage <= 1 || !this.user?.uid) {
      return null
    }

    const previousPage = targetPage - 1
    if (this.cacheService.has<number>(this.pageCursorCacheNamespace, previousPage)) {
      return this.cacheService.get<number, OperationPageCursor | null>(this.pageCursorCacheNamespace, previousPage) || null
    }

    const highestCachedPage = this.cacheService.getMaxNumericKey(this.pageCursorCacheNamespace)
    let startPage = highestCachedPage > 0 ? highestCachedPage + 1 : 1
    let cursor = highestCachedPage > 0
      ? this.cacheService.get<number, OperationPageCursor | null>(this.pageCursorCacheNamespace, highestCachedPage) || null
      : null
    const operationsRef = collection(this.db, `users/${this.user.uid}/operations`)

    for (let page = startPage; page <= previousPage; page += 1) {
      const pagedQuery = cursor
        ? query(
          operationsRef,
          orderBy('created_At', 'desc'),
          orderBy(documentId(), 'desc'),
          startAfter(cursor.createdAt, cursor.docId),
          limit(this.totalOperPerPage)
        )
        : query(operationsRef, orderBy('created_At', 'desc'), orderBy(documentId(), 'desc'), limit(this.totalOperPerPage))

      const pageSnap = await getDocs(pagedQuery)
      const pageLastDoc = pageSnap.empty ? null : pageSnap.docs[pageSnap.docs.length - 1]
      const pageCursor = this.toOperationsPageCursor(pageLastDoc)
      this.cacheService.set<number, OperationPageCursor | null>(this.pageCursorCacheNamespace, page, pageCursor)
      cursor = pageCursor

      if (pageSnap.empty) {
        break
      }
    }

    return this.cacheService.get<number, OperationPageCursor | null>(this.pageCursorCacheNamespace, previousPage) || null
  }

  private toOperationsPageCursor(docSnapshot: QueryDocumentSnapshot<DocumentData> | null): OperationPageCursor | null {
    if (!docSnapshot) {
      return null
    }

    return {
      createdAt: this.normalizeDateValue(docSnapshot.get('created_At')),
      docId: docSnapshot.id,
    }
  }

  private mapOperationDoc(operationDoc: QueryDocumentSnapshot<DocumentData>): CrawlOperation {
    const raw = operationDoc.data() as CrawlOperation & { created_At?: unknown }

    return {
      ...raw,
      id: operationDoc.id,
      created_At: this.normalizeDateValue(raw.created_At) as number,
      metrics: raw.metrics
        ? {
          ...raw.metrics,
          timestamp: this.normalizeMetricsTimestamp((raw.metrics as any).timestamp),
        }
        : raw.metrics,
    }
  }

  private normalizeDateValue(value: unknown): number {
    if (value instanceof Timestamp) {
      return value.toMillis()
    }

    if (value instanceof Date) {
      return value.getTime()
    }

    if (typeof value === 'number') {
      return value
    }

    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      return Number.isNaN(parsed) ? Date.now() : parsed
    }

    return Date.now()
  }

  private normalizeMetricsTimestamp(value: unknown): Date {
    if (value instanceof Timestamp) {
      return value.toDate()
    }

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? new Date() : value
    }

    if (typeof value === 'number' || typeof value === 'string') {
      const parsed = new Date(value)
      return Number.isNaN(parsed.getTime()) ? new Date() : parsed
    }

    return new Date()
  }

  private resetOperationsPaginationCache(): void {
    this.cacheService.clear(this.pageCursorCacheNamespace)
  }

  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.
    this.destroy$.next()
    this.destroy$.complete()
    this.crawlSubs?.unsubscribe()
    this.pagesSubs?.unsubscribe()
    this.timerSubs?.unsubscribe()
  }
}
