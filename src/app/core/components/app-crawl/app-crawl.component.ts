import { ChangeDetectorRef, ChangeDetectionStrategy, Component, DestroyRef, HostBinding, computed, inject, signal, WritableSignal } from '@angular/core';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { GinputComponent } from '../ginput/ginput.component';
import { FormBuilder, FormControl, FormGroup, Validators } from '@angular/forms';
import { AsyncPipe, JsonPipe, NgClass } from '@angular/common';
import { forkJoin } from 'rxjs/internal/observable/forkJoin';
import { takeUntil } from 'rxjs/internal/operators/takeUntil';
import { tap } from 'rxjs/internal/operators/tap';
import { AuthService, CrawlAPIService, FirestoreService, LocalStorage, OperationStatusService, SnackbarService, AnalyticsService, WebrainToolsService } from '../../services';
import { PricingRatesService } from '../../services/pricing-rates.service';
import { PricingEstimate } from '../../types/pricing-rates.interface';
import { ToolEnvelope } from '../../types';
import { Subject } from 'rxjs/internal/Subject';
import { concatMap } from 'rxjs/internal/operators/concatMap';
import { delay } from 'rxjs/internal/operators/delay';
import { CrawlOperation, CrawlPack, CrawlStatus, CrawlStreamBatch, CrawlTask, DropDownOption, Users } from '../../types'; // Removed CrawlResult from here
import { arrayBufferToString, crawlOperationStatusColor, setCrawlPackList } from '../../functions';
import { SnackBarType } from '../snackbar/snackbar.component';
import { MatIcon } from '@angular/material/icon';
import { RemoveToolbarDirective, RippleDirective } from '../../directives';
import { DropdownComponent } from '../dropdown/dropdown.component';
import { FormControlPipe } from '../../pipes';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { from } from 'rxjs/internal/observable/from';
import { startWith } from 'rxjs/internal/operators/startWith';
import { ClipboardbuttonComponent } from '../clipboardbutton/clipboardbutton.component';
import { expandCollapseAnimation } from 'src/app/animations';
import { MarkdownModule } from 'ngx-markdown';
import { BehaviorSubject, finalize, map, mergeMap, Observable, of, shareReplay, Subscription, takeLast, takeWhile, timer } from 'rxjs';
import { RadioToggleComponent } from '../radiotoggle/radiotoggle.component';
import { CrawlResult } from '../../types/crawl-result.type'; // Import the CrawlResult interface
import { CrawlResultItemComponent } from '../crawl-result-item/crawl-result-item.component';
import { ResultEnvelopeComponent, ResultEnvelopeMeta, ResultEnvelopeState } from '../result-envelope/result-envelope.component';
import { CrawlOperationStatus } from '../../enum';
import { HttpErrorResponse } from '@angular/common/http';
import { API_BASE_URL } from '../../variables';
import { UserInfo } from '@angular/fire/auth';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

const DEFAULT_CRAWL_PACK_SELECTION = { name: 'CRAWL.SELECT_PACK', code: 'default' }
@Component({
  selector: 'app-crawl',
  imports: [MatProgressSpinner, GinputComponent, MatIcon, NgClass, RippleDirective, DropdownComponent, FormControlPipe, RouterLink, MarkdownModule, RemoveToolbarDirective, JsonPipe, RadioToggleComponent, CrawlResultItemComponent, ResultEnvelopeComponent, AsyncPipe, MatProgressBarModule, TranslateModule],
  animations: [expandCollapseAnimation],
  templateUrl: './app-crawl.component.html',
  styleUrl: './app-crawl.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppCrawlComponent {
  @HostBinding('class') classes = 'flex items-center flex-col relative';
  readonly clipboardButton = ClipboardbuttonComponent

  private destroyRef = inject(DestroyRef)
  private localStorage = inject(LocalStorage)
  private translate = inject(TranslateService)
  private analytics = inject(AnalyticsService)
  private pricingService = inject(PricingRatesService)
  private webrainTools = inject(WebrainToolsService)
  private user: Users & { currProviderData: UserInfo | null } | null = null
  private destroy$ = new Subject<void>()

  protected latestTaskId = signal<string | null>(null); // Initialize with null if no task ID initially

  /**
   * What the NEXT run costs this caller, or null when it could not be read.
   *
   * A signal rather than an observable because it is set once: the answer depends
   * on the caller's tier and the route, not on the form, so there is nothing to
   * re-read as the user types. The template only reads it.
   */
  protected readonly costEstimate = signal<PricingEstimate | null>(null)


  crawlOptions: FormGroup

  crawlPackSelector: FormControl<DropDownOption | null>

  urls: FormControl<string>

  userprompt: FormControl<string>

  submitButton: FormControl<boolean>


  // Action Buttons
  protected itemVisibility: { [key: string]: WritableSignal<boolean> } = {};

  protected isCrawlProcessing: boolean
  protected errorMessage = ''

  protected abortButtonPressed: boolean

  // Results Area
  crawlResults: any[] = []; // Array to hold results (keeping as any[] as per instruction)
  taskStatus$: Observable<Pick<CrawlStatus, 'error' | 'status' | 'result'> | undefined | null>
  batchStringBuffer: string = ''
  progress: number | null // Progress percentage (0 to 100)
  

  // Data Lists
  crawlConfigPack: DropDownOption[] = []
  crawlpack: CrawlPack | undefined = undefined

  // Subscriptions
  loadPackSubscription: Subscription
  crawlSubscription: Subscription
  cancelSubscription: Subscription
  timerSub: Subscription


  // Get Variables 
  protected get stream() {
    return this.crawlOptions.get('stream')
  }

  constructor(
    private route: ActivatedRoute,
    private authService: AuthService,
    private fireService: FirestoreService,
    private crawlService: CrawlAPIService,
    private operStatusService: OperationStatusService,
    private snackbarService: SnackbarService,
    private cdr: ChangeDetectorRef,
    private fb: FormBuilder,
    private router: Router,

  ) {

    this.authService.user$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((user) => {
      this.user = user 
         console.log('appcrawl Fetched userdata from snapshot:', this.user);
    })
  }


  ngOnInit(): void {
    //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
    //Add 'implements OnInit' to the class.
    this.isCrawlProcessing = false
    this.abortButtonPressed = false
    this.progress = null

    this.taskStatus$ = of(undefined)

    // What the run about to be submitted costs, so the price is visible BEFORE
    // the button that spends it. Read from the route the submit will actually
    // use, so the estimate and the submit cannot name different paths.
    this.loadCostEstimate(this.estimatePath())

    this.urls = new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
      ]
    },)

    this.userprompt = new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.minLength(5),
        Validators.maxLength(4000) // Set the maximum length to 4000 characters
      ]
    })

    this.submitButton = new FormControl<boolean>(false, {
      nonNullable: true,
      validators: [
        Validators.required
      ]
    })

    this.crawlPackSelector = new FormControl<DropDownOption | null>(DEFAULT_CRAWL_PACK_SELECTION, {
      // updateOn: 'blur', //default will be change
      nonNullable: false,
      validators: [
        // Validators.required,
        // forbiddenNameValidator(/^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,6}(\/[^\s]*)?$/i)
      ]
    })

    const initStream = this.localStorage.getItem("stream") === undefined ? true : this.localStorage.getItem("stream") === "true"

    this.crawlOptions = this.fb.group({
      stream: new FormControl<boolean>(initStream, {
        // updateOn: 'change', //default will be change
        nonNullable: true,
        validators: [
          Validators.required
        ]
      }),
    })

    this.stream?.valueChanges.forEach((value: boolean) => {
      this.localStorage.setItem("stream", String(value))
      if (this.crawlpack && this.crawlpack.config
        && this.crawlpack.config.value
        && this.crawlpack.config.value.crawler_config) {
        this.crawlpack.config.value["crawler_config"].params.stream = value;
      }
      // this.browserCookies.closeModal = !value
    })

    // load most 10 recent crawl packs
    if (this.user?.uid)
      this.loadPackSubscription = from(this.fireService.loadPreviousPacks(this.user.uid))
        .pipe(startWith(undefined)) // Emit undefined initially to avoid flickering in the UI
        .subscribe({
          next: (pack: CrawlPack[] | null | undefined) => {
            if (!pack)
              return
            if (pack.length)
              setCrawlPackList(pack, this.crawlConfigPack)

            this.localStorage.setItem("crawlpack", JSON.stringify(pack))
            this.cdr.markForCheck() // Notify Angular of the change

          },
          error: (err: any) => {
            console.error(err)
          }
        })

  }

  submitCrawlJob() {
    console.log('Crawl Operation Started', this.urls.value)

    // return an error message if url or userpormpt is invalid
    if (!this.urls.valid || this.crawlPackSelector.value?.code === 'default')
      return

    this.crawlResults = [] // reset the results array
    
    // reset the results
    this.closeResults()

    // disable the form
    this.disableForm()

    // start the crawl operation
    this.isCrawlProcessing = true

    // enqueue crawl request to the python server api celery app
    this.crawlEnqueue(this.urls.value)
  }

  crawlEnqueue(formInput: string) {

    let urls = formInput.trim().split(',')
    const operationData = this.setupOperationData()
    // Create a new CrawlConfig object
    this.crawlSubscription = this.crawlService.multiCrawlEnqueue(urls, operationData, this.crawlpack as CrawlPack)
      .pipe(
        takeUntil(this.destroy$),
        // ponytail: one crawl_started emit at the single enqueue choke point.
        tap((task: CrawlTask) => {
          this.updateUIStatus(task.id)
          this.analytics.trackEvent('crawl_started', { taskId: task.id, urlCount: urls.length })
            .subscribe({ error: () => undefined })
        }),
        // tap((task: CrawlTask) => console.log('a new crawl task' + ' added' + ' to the qeueu: ', task)),
        delay(3000), // Delay to ensure the request is sent
        concatMap((task: CrawlTask) => {
          /* Initialize the Results viariables  */
          this.errorMessage = ''

          this.latestTaskId.set(task.id) // Emit the current task ID
          console.log('Crawl task started with id:', task.id)

          // process the data return streaming response
          return this.crawlService.streamTaskResults(task._links.self.href, task.id)
        })
      ).subscribe({
        next: (taskResult: CrawlStreamBatch) => {

          if (taskResult.progress !== undefined) {
            this.progress = taskResult.progress
          }
          // add data to the dom as they coming to the frontend
          this.addCrawlResult(taskResult)
          this.cdr.markForCheck() // Mark for check after data updates
        },
        complete: () => {
          // reset the processing status
          this.isCrawlProcessing = false

          this.progress = 100 // Set progress to 100% when complete

          // reset the form
          this.enableForm()
          this.latestTaskId.set(null)
          this.cdr.markForCheck() // Mark for check on completion
          // detect changes
          // this.cdr?.detectChanges()
        },
        error: (error: any) => {

          // print the error
          console.error('Error processing data:', error, error.message);
          // set the error message to show on the screen by snackbar popup
          this.errorMessage = error.message || this.translate.instant('CRAWL.ERR_PROCESSING_DATA');

          this.latestTaskId.set(null)
          this.cdr.markForCheck() // Mark for check on error
          // show snackbar Error
          this.showSnackbar(this.errorMessage || "", SnackBarType.error, '', 5000)
        }
      })
  }

  setupOperationData(): CrawlOperation {

    const operationData: CrawlOperation = {
      type: 'playground',
      author: {
        displayName: this.user?.currProviderData?.displayName || "anonymous",
        uid: this.user?.uid || "anonymous"
      },
      name: `Crawl Job - Playground`,
      created_At: Date.now(),
      scheduled_At: Date.now(),
      prompt: this.userprompt.value || '',
      urlPath: this.router.url || 'unknown',
      metadataId: this.crawlpack?.id || 'unknown',
      urls: this.urls.value.trim().split(',') || [],
      status: CrawlOperationStatus.READY,
      color: crawlOperationStatusColor(CrawlOperationStatus.READY),
    }

    return operationData
  }

  onDropDownSelected(event: DropDownOption) {

    const packId: string = event.code

    const storageItem: string | null = this.localStorage.getItem("crawlpack")

    if (!storageItem)
      return

    const recentPacks: CrawlPack[] = JSON.parse(storageItem)

    const pack = recentPacks.find((pack) => pack.id === packId)

    if (!pack)
      return

    this.itemVisibility[packId] = signal(false)
    this.itemVisibility['markdown'] = signal(this.itemVisibility[packId]())

    this.crawlpack = pack

    // This code snippet is checking if the `crawler_config` property exists in the `config` object of
    // `this.crawlpack`. If it exists, it retrieves the value of the `stream` property from
    // `crawler_config`.
    const isConfigStreamON = this.crawlpack.config.value["crawler_config"]?.params?.stream
    if (!isConfigStreamON)
      this.crawlpack.config.value["crawler_config"].params.stream = this.stream?.value
    else {
      this.stream?.setValue(isConfigStreamON)
    }
    this.cdr.markForCheck() // Mark for check after dropdown selection

  }

  protected openJsonFormat(event: Event, packKey: any) {

    event.stopPropagation()

    if (!this.crawlpack)
      return

    // toggle visibility of packValue
    this.itemVisibility[packKey]?.update(prev => {
      if (prev) {
        return !prev
      }
      return true
    })

    this.timerSub = timer(300).subscribe(() => {
      this.itemVisibility['markdown'].set(this.itemVisibility[packKey]());
    });

  }


  /**
   * Display Results Function
   */

  /**
   * Updates the UI status based on the task status retrieved from the `crawlService`.
   * @param {string} id - The task ID for which the status is being updated.
   */
  updateUIStatus(id: string) {
    this.taskStatus$ = this.operStatusService.getTaskStatusWithSnackbar(
      id,
      (msg, type) => this.showSnackbar(msg, type)
    ).pipe(
    shareReplay(1) // Ensures only one HTTP request is made, even with multiple subscribers
  )
  }

  // Method to add new results (this would be called when a new streaming event arrives)
  addCrawlResult(line: CrawlStreamBatch) {
    if (!line) return;

    if (line.status === "ok") {
      this.handleOkChunk(line);
    } else if (line.status === "error" && line.message) {
      this.handleError(line.message);
    }
  }

  private handleOkChunk(chunk: CrawlStreamBatch) {
    if (chunk.chunk_index === '0' && this.batchStringBuffer) {
      this.processBatchBuffer(chunk.message)
    }

    if (chunk.type === 'batch_chunk' && chunk.dump && typeof chunk.dump === 'string') {
      this.batchStringBuffer += chunk.dump;
    }

    if (chunk.message === "completed") {
      this.processBatchBuffer("completed")
    }
  }

  private processBatchBuffer(message?: string) {
    try {
      const dump: CrawlResult = JSON.parse(this.batchStringBuffer);
      this.crawlResults.push({
        ...dump,
        message: message || "processing",
        expanded: true,
      })
    } catch (error) {
      console.error("Failed to parse dump JSON:", error);
      this.showSnackbar(this.translate.instant('CRAWL.ERR_PARSE_RESULT'), SnackBarType.error, '', 5000);
    } finally {
      this.batchStringBuffer = '';
    }
  }

  private handleError(message: string) {
    console.error("Error chunk received:", message);
    this.errorMessage = message;
    this.showSnackbar(message, SnackBarType.error, '', 5000);
  }

  // Toggle visibility of a result item
  toggleResultVisibility(result: any) {
    result.expanded = !result.expanded;
  }

  // TrackBy function for *ngFor performance
  trackByCrawlResult(index: number, result: any): any {
    // Assuming each result has a unique identifier, e.g., a timestamp or a URL
    // If not, index can be used, but a unique ID is better for reordering/filtering
    return result.url || index;
  }

  /**
   * Important Functions
   */
  // 'info' | 'success' | 'warning' | 'error'
  showSnackbar(
    message: string,
    type: SnackBarType = SnackBarType.info,
    action: string | '' = '',
    duration: number = 3000) {

    this.snackbarService.showSnackbar(message, type, action, duration)
  }
  clearForm() {
    // reset url
    this.urls.setValue('')

    // reset crawlpack dropdown 
    this.crawlPackSelector.setValue(DEFAULT_CRAWL_PACK_SELECTION)

    // remove results
    this.crawlResults = []
    
    this.closeResults()
  }

  enableForm() {

    this.urls.enable()
    this.stream?.enable()
    this.crawlPackSelector.enable()
    this.submitButton.setValue(false)
  }

  private disableForm() {
    this.urls.disable()
    this.stream?.disable()
    this.crawlPackSelector.disable()
    this.submitButton.setValue(true)
  }

  protected closeResults() {

    // Close results, reset results variables and subscribers
    this.taskStatus$ = of(undefined)
    this.abortButtonPressed = false
    this.progress = null
    this.batchStringBuffer = '' // reset the batch string buffer

    // this.jsonChunk['usage'] = null
    // this.jsonChunk['content'] = '']
    this.destroy$.next()
    this.latestTaskId.set(null)
    this.loadPackSubscription?.unsubscribe()
    this.crawlSubscription?.unsubscribe()
    this.cancelSubscription?.unsubscribe()
    // this.forkJoinSubscription?.unsubscribe()
  }

  abortRequests() {
    const taskId = this.latestTaskId()

    console.log("cancel task by id ",taskId)
    if(!taskId || this.abortButtonPressed)
      return
    
    
    // Emit a signal to cancel the request
    this.destroy$.next()
    // this.crawlSubscription?.unsubscribe()
    this.abortButtonPressed = true

    // send cancel job request
    this.cancelSubscription = this.crawlService.cancelTask(taskId)
    .pipe(takeUntil(this.destroy$))
    .subscribe({
      next: (res: {status: string, message: string}) => {
        switch(res.status) {
          case SnackBarType.warning:
            this.showSnackbar(res.message, SnackBarType.warning)
            break
          case "ok":
            // this.closeResults()
            // new request to cancel and terminate the celery task
            this.showSnackbar(res.message, SnackBarType.info)
            break
        }
      },

      error: (error) => {
        this.abortButtonPressed = this.isCrawlProcessing = false
        this.enableForm()
        console.log("an error occured on cancelation process: ", error)
      },
      complete: () => {
        
        this.abortButtonPressed = this.isCrawlProcessing = false
        this.enableForm()
      }
    })
  }

  /**
   * ---------------------------------------------------------------------------
   * Walk and batch: the two webrain tool routes this mode can also run.
   * ---------------------------------------------------------------------------
   *
   * Why they belong in this mode
   * ----------------------------
   * The tools panel runs one tool and renders one envelope; it has no notion of a
   * seed or of "the pages this site has". A site walk IS that. This mode could
   * previously only scrape the exact URLs typed, so a user who pasted a real site
   * got one page back and reasonably concluded the crawl was broken.
   *
   * What is deliberately NOT exposed
   * --------------------------------
   * `same_domain` and `respect_robots` are absent although the route accepts
   * them, because `crawlArguments` forwards those flags only when they are `true`
   * (`if (source?.[field] === true)`). A checkbox could therefore never turn
   * either one OFF -- it would read as a working control and change nothing, so
   * offering it would be worse than omitting it.
   *
   * Field names here are the HTTP surface's, as `batchArguments` and
   * `crawlArguments` in `functions/src/handlers/webrain-tools.ts` define them --
   * not the worker's, which is what the gateway exists to translate.
   */

  /** What the form runs: the existing queue, `webrain_crawl`, or `webrain_batch`. */
  protected readonly runMode = signal<'scrape' | 'walk' | 'batch'>('scrape')

  /** `webrain_crawl`'s mode; the route requires one of the four. */
  protected readonly walkMode = signal<string>('spider')

  /** The walk strategy. Only `spider` reads it. */
  protected readonly walkStrategy = signal<string>('bfs')

  /** `webrain_batch`'s op; the route refuses `eval` and anything unknown. */
  protected readonly batchOp = signal<string>('fetch')

  /** Discover URLs without fetching page content -- the cheap way to map a site. */
  protected readonly walkNoContent = signal(false)

  /** Optional numeric limits, held as text because `app-ginput` binds a text control. */
  protected readonly walkMaxPages = new FormControl('', { nonNullable: true })
  protected readonly walkMaxDepth = new FormControl('', { nonNullable: true })
  protected readonly batchConcurrency = new FormControl('', { nonNullable: true })

  /** A vault filename for `op=fetch|extract`; the route validates the charset. */
  protected readonly batchOutput = new FormControl('', { nonNullable: true })

  protected readonly toolState = signal<ResultEnvelopeState>('idle')
  protected readonly toolEnvelope = signal<ToolEnvelope | null>(null)
  protected readonly toolError = signal('')

  /** The payload, pretty-printed. A getter: it is read once per render pass. */
  protected get toolPretty(): string {
    const reply = this.toolEnvelope()
    return reply ? JSON.stringify(reply.data ?? reply, null, 2) : ''
  }

  /** Header chips: what the worker reported about its own call. */
  protected get toolMeta(): ResultEnvelopeMeta[] {
    const reply = this.toolEnvelope()
    if (!reply) {
      return []
    }
    const chips: ResultEnvelopeMeta[] = []
    if (typeof reply.tokens === 'number') {
      chips.push({ label: 'TOOLS.META_TOKENS', value: String(reply.tokens), tone: 'neutral' })
    }
    if (typeof reply.ms === 'number') {
      chips.push({ label: 'TOOLS.META_MS', value: String(reply.ms), tone: 'neutral' })
    }
    return chips
  }

  /** The envelope's heading, which is the only thing that differs between the two. */
  protected get toolTitleKey(): string {
    return this.runMode() === 'walk' ? 'CRAWL.TITLE_WALK' : 'CRAWL.TITLE_BATCH'
  }

  protected get toolBusy(): boolean {
    return this.toolState() === 'loading'
  }

  /** Only a transport failure is worth retrying; a refusal will refuse again. */
  protected get toolShowRetry(): boolean {
    return this.toolState() === 'error' && this.toolEnvelope()?.transportError === true
  }

  /**
   * Whether the run button is unavailable.
   *
   * Scrape additionally needs a pack selected, because it enqueues a STREAM job
   * whose config IS the pack. The two tool routes take their arguments from the
   * form itself and need none, so demanding one there would block a run for a
   * reason that does not exist.
   */
  protected get runDisabled(): boolean {
    if (this.runMode() !== 'scrape') {
      return this.urls.invalid || this.toolBusy
    }
    return this.urls.invalid || this.submitButton.value ||
      this.crawlPackSelector.value?.code === 'default'
  }

  /** The route the current run will hit, and therefore the one to price. */
  private estimatePath(): string {
    switch (this.runMode()) {
      case 'walk':
        return API_BASE_URL + '/spider'
      case 'batch':
        return API_BASE_URL + '/batch'
      default:
        return this.crawlService.jobEnqueuePath
    }
  }

  /**
   * Read the price of one route.
   *
   * Deliberately silent on failure: a price that cannot be read must not block or
   * visibly fail a run. The run reports its own outcome, and the charge (if any)
   * is shown in billing.
   * @param {string} path The route to price.
   * @return {void}
   */
  private loadCostEstimate(path: string): void {
    this.pricingService
      .estimate('POST', path)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (reply) => this.costEstimate.set(reply.estimate),
        error: () => this.costEstimate.set(null),
      })
  }

  /**
   * Switch what the form runs.
   *
   * Re-prices, because the three routes do not cost the same, and clears the
   * previous reply -- a batch's answer left under a walk's heading would read as
   * the walk's answer.
   * @param {string} mode The chosen run mode.
   * @return {void}
   */
  protected setRunMode(mode: string): void {
    this.runMode.set(mode as 'scrape' | 'walk' | 'batch')
    this.resetToolRun()
    this.loadCostEstimate(this.estimatePath())
  }

  /** @param {string} mode The chosen crawl mode. @return {void} */
  protected setWalkMode(mode: string): void {
    this.walkMode.set(mode)
  }

  /** @param {string} strategy The chosen traversal order. @return {void} */
  protected setWalkStrategy(strategy: string): void {
    this.walkStrategy.set(strategy)
  }

  /** @param {string} op The chosen batch operation. @return {void} */
  protected setBatchOp(op: string): void {
    this.batchOp.set(op)
  }

  /**
   * Run the selected tool route.
   *
   * Only the arguments the user actually filled in are sent, because the mapper
   * treats a present-but-unparseable value as a refusal rather than as a default.
   * The targets come from the same control the scrape mode uses, so there is one
   * place to type a URL rather than three. For a walk the FIRST entry is the
   * seed; `validate` uses the whole list, which the route's own normalisation
   * handles, so the caller does not pick a field per mode.
   * @return {void}
   */
  protected runTool(): void {
    if (this.toolBusy) {
      return
    }

    const targets = this.urls.value
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean)

    if (!targets.length) {
      return
    }

    const body: Record<string, unknown> = { urls: targets }
    let call: Observable<ToolEnvelope>

    if (this.runMode() === 'walk') {
      body['mode'] = this.walkMode()
      body['strategy'] = this.walkStrategy()
      if (this.walkNoContent()) {
        body['no_content'] = true
      }
      this.addNumber(body, 'max_pages', this.walkMaxPages.value)
      this.addNumber(body, 'max_depth', this.walkMaxDepth.value)
      call = this.webrainTools.spider(body)
    } else {
      body['op'] = this.batchOp()
      this.addNumber(body, 'concurrency', this.batchConcurrency.value)
      const output = this.batchOutput.value.trim()
      if (output) {
        body['output'] = output
      }
      call = this.webrainTools.batch(body)
    }

    this.toolState.set('loading')
    this.toolError.set('')
    this.toolEnvelope.set(null)

    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (reply) => this.applyToolReply(reply),
      error: (error: HttpErrorResponse) => this.applyToolFailure(error),
    })
  }

  /** Re-run the same submission. */
  protected retryTool(): void {
    this.runTool()
  }

  /**
   * Copy one optional number into the body, if it is one.
   *
   * An unparseable or non-positive value is omitted rather than sent as `NaN`,
   * because the mapper refuses a non-positive integer: sending one would turn a
   * typo into a failed run instead of into a default.
   * @param {Record<string, unknown>} body The body being built.
   * @param {string} field The HTTP field name.
   * @param {string} raw The control's text.
   * @return {void}
   */
  private addNumber(body: Record<string, unknown>, field: string, raw: string): void {
    const parsed = Number(raw.trim())
    if (raw.trim() && Number.isFinite(parsed) && parsed > 0) {
      body[field] = parsed
    }
  }

  /**
   * Fold one reply into view state.
   *
   * `error` is checked rather than `status`, because the 400 the argument mapper
   * produces has neither `provider` nor `status` -- it is the gateway refusing
   * the body, not the worker answering.
   * @param {ToolEnvelope} reply The reply.
   * @return {void}
   */
  private applyToolReply(reply: ToolEnvelope): void {
    this.toolEnvelope.set(reply)

    if (reply.error) {
      this.toolState.set('error')
      this.toolError.set(reply.error)
      return
    }

    this.toolState.set('ready')
    this.toolError.set('')
  }

  /**
   * Fold a failed response into view state.
   *
   * The server's own text is preferred over a status-code guess: it is an
   * envelope on every status these routes produce, and a refusal (403) reads very
   * differently from an outage (502).
   * @param {HttpErrorResponse} error The failed response.
   * @return {void}
   */
  private applyToolFailure(error: HttpErrorResponse): void {
    const body = error.error as ToolEnvelope | null
    this.toolEnvelope.set(body)

    this.toolState.set('error')
    this.toolError.set(
      typeof body?.error === 'string' && body.error ? body.error : 'TOOLS.ERR_REQUEST',
    )
  }

  /** Back to the opening state, keeping the run mode. */
  private resetToolRun(): void {
    this.toolEnvelope.set(null)
    this.toolError.set('')
    this.toolState.set('idle')
  }

  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.
    // Complete the Subject to prevent memory leaks
    this.crawlResults = []
    this.closeResults()
    this.destroy$.complete()
    this.timerSub?.unsubscribe()
  }

}
