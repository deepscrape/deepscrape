import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, inject, ViewChild, AfterViewInit, OnDestroy, DestroyRef, signal } from '@angular/core'
import { FormArray, FormBuilder, FormGroup, ReactiveFormsModule, Validators, FormControl, FormsModule } from '@angular/forms'
import { CrawlOperation, CrawlResult, CrawlStatus, CrawlStreamBatch, CrawlTask, Preset, SeederRequest, SeederResult, Users } from '../../types'
import { LocalStorage, SeedingService, ScreenResizeService, WindowToken, CrawlAPIService, SnackbarService, OperationStatusService, AuthService } from '../../services'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { concatMap, delay, Observable, of, shareReplay, Subject, Subscription, takeUntil, tap, timer } from 'rxjs'
import { AsyncPipe, NgClass } from '@angular/common';
import { MatSliderModule } from '@angular/material/slider'
import { CheckboxComponent } from '../checkbox/checkbox.component'
import { MatChipsModule } from '@angular/material/chips'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatInputModule } from '@angular/material/input'
import { MatIconModule } from '@angular/material/icon'
import { HiddenDragScrollDirective, RippleDirective } from '../../directives'
import { expandCollapseAnimation, fadeInUp } from 'src/app/animations'
import { SnackBarType } from '../snackbar/snackbar.component'
import { SeederResultsComponent } from '../seeder-results/seeder-results.component'
import { crawlOperationStatusColor } from '../../functions'
import { CrawlOperationStatus } from '../../enum'
import { UserInfo } from '@angular/fire/auth'
import { Router } from '@angular/router'
import { MatProgressBarModule } from '@angular/material/progress-bar'
import { TranslateModule } from '@ngx-translate/core'

// Type definitions for preset configurations
@Component({
  selector: 'app-domain-seeder', imports: [ReactiveFormsModule, NgClass, MatSliderModule, CheckboxComponent, FormsModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatIconModule, AsyncPipe, MatProgressBarModule, HiddenDragScrollDirective, RippleDirective, SeederResultsComponent, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [expandCollapseAnimation, fadeInUp],
  templateUrl: './domain-seeder.component.html',
  styleUrl: './domain-seeder.component.scss',
})
export class DomainSeederComponent implements AfterViewInit, OnDestroy {

  private window = inject(WindowToken)
  @ViewChild('scrollContainer') scrollContainer!: ElementRef
  private localStorage = inject(LocalStorage)
  private destroyRef = inject(DestroyRef)
  private screenResizeService = inject(ScreenResizeService)
  private cdr = inject(ChangeDetectorRef)
  private user: Users & { currProviderData: UserInfo | null } | null = null
  private destroy$ = new Subject<void>()

  protected latestTaskId = signal<string | null>(null) // Initialize with null if no task ID initially


  // Scroll indicators
  showLeftScroller = false
  showRightScroller = true // Initially assume we have content to the right
  isScrolling = false // Track if a scroll animation is in progress

  // Preset configurations
  presets: Preset[] = []

  // Chips for domains and queries
  separatorKeysCodes: number[] = [13, 188] // Enter, comma
  domainInputControl = new FormControl('')
  queryInputControl = new FormControl('')


  researchForm: FormGroup
  results: SeederResult[] = []
  protected isSeederProcessing: boolean
  protected errorMessage = ''
  protected abortButtonPressed: boolean
  streaming = false
  isExpanded = false // Default collapsed state
  activePreset: string = '' // Track active preset
  formTitle: string = 'DOMAIN_SEEDER.TITLE_DEFAULT' // Default title (i18n key path)

  taskStatus$: Observable<Pick<CrawlStatus, 'error' | 'status' | 'result'> | undefined | null>

  batchStringBuffer: string = ''
  progress: number | null // Progress percentage (0 to 100)

  seederSubscription: Subscription
  cancelSubscription: Subscription
  timerSub: Subscription


  constructor(
    private fb: FormBuilder,
    private seedingService: SeedingService,
    private crawlService: CrawlAPIService,
    private snackbarService: SnackbarService,
    private operStatusService: OperationStatusService,
    private authService: AuthService,
    private router: Router,
  ) {
    this.researchForm = this.fb.group({
      domains: this.fb.array([]),  // Start with empty array, we'll add domains through the UI
      config: this.fb.group({
        source: this.fb.control('sitemap+cc'),
        pattern: this.fb.control('*'),
        live_check: this.fb.control(false),
        extract_head: this.fb.control(false),
        max_urls: this.fb.control(-1),
        concurrency: this.fb.control(1000),
        hits_per_sec: this.fb.control(5),
        force: this.fb.control(false),
        base_directory: this.fb.control(''),
        verbose: this.fb.control(false),
        query: this.fb.control('', { nonNullable: true }),  // Will store comma-separated queries
        score_threshold: this.fb.control(0.3),
        scoring_method: this.fb.control('bm25'),
        filter_nonsense_urls: this.fb.control(true)
      }),
      stream: this.fb.control(false)
    })

    this.authService.user$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((user) => {
      this.user = user
      console.log('appcrawl Fetched userdata from snapshot:', this.user)
    })
  }

  get domains() {
    return this.researchForm.get('domains') as FormArray
  }
  get queries() {
    return this.researchForm.get('config.query') as FormControl
  }

  // Helper method to get query values as an array
  get queryValues(): string[] {
    const queryControl = this.researchForm.get('config.query')
    if (queryControl && queryControl.value) {
      return queryControl.value.split(',').filter((q: string) => q.trim() !== '')
    }
    return []
  }


  ngOnInit() {
    // this.results = [{ "url": "https://market.tutorialspoint.com/categories/automation", 
    //   "status": "valid", "head_data": { 
    //     "title": "Automation Certification Courses Online [2025] | Tutorialspoint", 
    //     "charset": "utf-8", "meta": { 
    //       "x-ua-compatible": "IE=edge", "viewport": "width=device-width,initial-scale=1.0,user-scalable=yes", "csrf-token": "Z79cPwvtt2214pdi77bGxNBTrYUPLg5fel7NeCnC", "description": "Enroll in the latest Automation courses to improve your skills. Choose the best Automation courses from industry experts and top instructors.", "keywords": "Automation courses, Automation certifications, Automation video courses, Automation books", "og:title": "Automation Certification Courses Online [2025] | Tutorialspoint", "og:type": "course", "og:url": "https://market.tutorialspoint.com/categories/automation", "og:site_name": "TutorialsPoint", "og:description": "Enroll in the latest Automation courses to improve your skills.", "og:image": "https://market.tutorialspoint.com/images/logo.png", "og:image:type": "image/png", "og:image:width": "320", "og:image:height": "420", "google-site-verification": "a3lTjqnrYy0FULTFuVXuYcpoVYUK9PpZO9TlkgCqiO8" }, "link": { "shortcut": [ { "href": "https://market.tutorialspoint.com/favicon.ico?v=1.1", "type": "image/x-icon" } ], "icon": [ { "href": "https://market.tutorialspoint.com/favicon.ico?v=1.1", "type": "image/x-icon" } ], "canonical": [ { "href": "https://market.tutorialspoint.com/categories/automation" } ], "preconnect": [ { "href": "https://fonts.googleapis.com" }, { "href": "https://fonts.gstatic.com" } ], "stylesheet": [ { "href": "https://fonts.googleapis.com/css2?family=Nunito:wght@400500600700&family=Lato:wght@400700&family=Poppins:wght@400500600&family=Raleway:wght@500&display=swap" }, { "href": "/public/assets/newDesign/css/style.css?v=1.33" }, { "href": "https://cdn.jsdelivr.net/npm/swiper@7/swiper-bundle.min.css" }, { "href": "https://vjs.zencdn.net/8.3.0/video-js.css?v=1.02" }, { "href": "/public/assets/newDesign/css/toastr.css?v=1.02" } ] }, "jsonld": [ { "@context": "https://schema.org/", "@type": "WebPage", "name": "Automation Certification Courses Online [2025] | Tutorialspoint", "speakable": { "@type": "SpeakableSpecification", "xpath": [ "/html/head/title", "/html/head/meta[@name='description']/@content" ] }, "url": "https://market.tutorialspoint.com/categories/automation" } ] }, "relevance_score": 1.0, "domain": "tutorialspoint.com", "query": "web scraping automation selenium" }]

    this.abortButtonPressed = this.isSeederProcessing = false
    this.progress = null

    this.taskStatus$ = of(undefined)


    this.setPresets()

    // Add validators to input controls
    this.domainInputControl.setValidators([Validators.pattern(/^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/.*)?$/)])

    // Add live validation feedback
    // this.domainInputControl.valueChanges.subscribe(value => {
    //   // No action needed, validation is handled by Angular
    // })

    // this.queryInputControl.valueChanges.subscribe(value => {
    //   // No action needed, validation is handled by Angular
    // })

    // Check if there's a saved preset in localStorage
    const savedPreset = this.localStorage.getItem('domain-seeder-preset')
    if (savedPreset) {
      try {
        const presetData = JSON.parse(savedPreset)
        if (presetData.id && this.presets.some(p => p.id === presetData.id)) {
          this.applyPreset(presetData.id)
        }
      } catch (e) {
        console.error('Error restoring saved preset', e)
      }
    }

    // Set initial expanded state (read from localStorage or default to false)
    this.isExpanded = this.localStorage.getItem('domain-seeder-expanded') === 'true' || false
  }


  ngAfterViewInit(): void {
    // Initial check for scroll indicators using timer instead of setTimeout
    timer(0)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.checkScrollPosition())

    // Subscribe to screen resize events
    this.screenResizeService.onResize$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        // Wait a bit for the DOM to update after resize
        timer(150)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(() => this.checkScrollPosition())
      })
  }

  toggleExpand() {
    this.isExpanded = !this.isExpanded
    // Save expanded state to localStorage
    this.localStorage.setItem('domain-seeder-expanded', this.isExpanded.toString())
  }

  // Validate that we have at least one domain
  validateDomains(): boolean {
    return this.domains.controls.length > 0
  }

  formatLabel(value: number): string {

    return `${value}`
  }

  addDomain() {
    this.domains.push(this.fb.control('', Validators.required))
  }

  removeDomain(index: number) {
    this.domains.removeAt(index)
  }

  getFormControl(path: string): FormControl<boolean> {
    return this.researchForm.get(path) as FormControl<boolean>
  }
  addDomainChip(event: any) {
    const value = (event.value || '').trim()
    if (value && this.isDomainValid(value)) {
      // Add to domains form array
      this.domains.push(this.fb.control(value, [Validators.required, this.domainPatternValidator() as any]))
      this.domainInputControl.setValue('')
    }
  }

  removeDomainChip(domain: string) {
    const domainsArray = this.domains
    const index = domainsArray.value.indexOf(domain)
    if (index > -1) {
      domainsArray.removeAt(index)
    }
  }

  isDomainValid(domain: string): boolean {
    // Simple domain pattern: example.com or sub.example.com
    return /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/.*)?$/.test(domain)
  }

  domainPatternValidator() {
    return (control: FormControl) => {
      return this.isDomainValid(control.value) ? null : { pattern: true }
    }
  }

  addQueryChip(event: any) {
    const value = (event.value || '').trim()
    const queryControl = this.researchForm.get('config.query')
    if (queryControl && value) {
      // Store comma-separated values in the query control
      const currentValue = queryControl.value || ''
      const queries = currentValue.split(',').filter((q: string) => q.trim() !== '')

      // Add the new value if it's not already in the list
      if (!queries.includes(value)) {
        queries.push(value)
      }

      queryControl.setValue(queries.join(','))
      this.queryInputControl.setValue('')
    }
  }

  removeQueryChip(query: string) {
    const queryControl = this.researchForm.get('config.query')
    if (queryControl) {
      const currentValue = queryControl.value || ''
      const queries = currentValue.split(',').filter((q: string) => q.trim() !== '' && q !== query)
      queryControl.setValue(queries.join(','))
    }
  }

  /**
   * Handle preset container scroll events to update directional indicators
   */
  onPresetScroll(event: Event): void {
    // If this scroll event was triggered by a button click, we already handle indicator updates
    if (this.isScrolling) return

    // Use timer to debounce the scroll event for drag-initiated scrolls
    timer(50)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.checkScrollPosition())
  }
  /**
 * Check scroll position and update directional indicators
 */
  private checkScrollPosition(): void {
    const element = this.scrollContainer?.nativeElement
    if (!element) return

    // Check if scrolled to the left
    this.showLeftScroller = element.scrollLeft > 5 // Show left indicator if scrolled right

    // Check if scrolled to the right end
    const isAtRightEnd = Math.abs(
      (element.scrollWidth - element.clientWidth - element.scrollLeft)
    ) < 5

    this.showRightScroller = !isAtRightEnd // Show right indicator if not at the end
  }
  /**
 * Scroll the preset chips container left or right when arrow buttons are clicked
 * @param direction 'left' or 'right'
 */

  scrollPresets(direction: 'left' | 'right'): void {
    const element = this.scrollContainer?.nativeElement
    if (!element || this.isScrolling) return

    // Set scrolling state
    this.isScrolling = true

    // Calculate scroll amount (more YouTube-like with about 85% of the visible width)
    const scrollAmount = Math.floor(element.clientWidth * 0.85)

    // Animate the scroll with YouTube-like behavior
    const startPosition = element.scrollLeft
    const targetPosition = direction === 'left'
      ? Math.max(0, startPosition - scrollAmount)
      : startPosition + scrollAmount

    // Use manual animation for better compatibility with overflow-x-hidden on mobile
    this.smoothScrollHorizontally(element, startPosition, targetPosition, 300)
  }

  /**
   * Custom smooth scroll implementation that works with overflow-x-hidden
   * Uses requestAnimationFrame for smoother scrolling on all devices
   */
  private smoothScrollHorizontally(
    element: HTMLElement,
    startPosition: number,
    targetPosition: number,
    duration: number
  ): void {
    const startTime = performance.now()

    const animateScroll = (currentTime: number) => {
      const elapsedTime = currentTime - startTime

      if (elapsedTime >= duration) {
        // Animation complete
        element.scrollLeft = targetPosition
        this.isScrolling = false
        this.checkScrollPosition()
        return
      }

      // Calculate eased position (cubic easing)
      const progress = elapsedTime / duration
      const easedProgress = this.easeInOutCubic(progress)
      const position = startPosition + (targetPosition - startPosition) * easedProgress

      // Apply the scroll position
      element.scrollLeft = position

      // Continue animation
      this.window.requestAnimationFrame(animateScroll)
    }

    // Start the animation
    this.window.requestAnimationFrame(animateScroll)
  }

  /**
   * Cubic easing function for smoother scroll animation
   */
  private easeInOutCubic(t: number): number {
    return t < 0.5
      ? 4 * t * t * t
      : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1
  }

  // Check if form is valid (including custom validations)
  isFormValid(): boolean {
    return this.researchForm.valid && this.validateDomains()
  }
  onSubmit() {
    // Mark all fields as touched to trigger validation display
    this.researchForm.markAllAsTouched()

    if (!this.isFormValid()) {
      console.debug('Form validation failed', {
        formValid: this.researchForm.valid,
        domainCount: this.domains.length
      })
      return
    }


    this.results = [] // reset the results array

    // reset the results
    this.closeResults()
    // Prepare the seeding request

    // disable the form
    this.disableForm()

    this.isSeederProcessing = true

    const request = this.preparePayload()

    // console.log('Seeding request', request) // Log the request for debugging

    this.seederEnqueue(request)
  }  // Apply selected preset configuration

  private seederEnqueue(request: SeederRequest) {

    const operationData = this.setupOperationData(request.domains)


    this.seederSubscription = this.seedingService.multiSeedEnqueue(operationData, request)
      .pipe(

        takeUntil(this.destroy$),
        tap((task: CrawlTask) => this.updateUIStatus(task.id)), // ensure that ui prints the task status
        delay(3000), // Delay to ensure the request is sent
        concatMap((task: CrawlTask) => {
          /* Initialize the Results viariables  */
          this.errorMessage = ''
          this.isSeederProcessing = true

          this.latestTaskId.set(task.id) // Emit the current task ID

          // process the data return streaming response
          return this.seedingService.streamTaskResults(task._links.self.href, task.id)
        })
      ).subscribe({
        next: (taskResult: CrawlStreamBatch) => {

          if (taskResult.progress !== undefined) {
            this.progress = taskResult.progress
          }
          // add data to the dom as they coming to the frontend
          this.addCrawlResult(taskResult)
          // OnPush: progress arrives from the streaming response.
          this.cdr.markForCheck()
        },
        complete: () => {
          // reset the processing status
          this.isSeederProcessing = false

          this.progress = 100 // Set progress to 100% when complete

          // reset the form
          this.enableForm()

          this.latestTaskId.set(null)
          this.cdr.markForCheck()
        },
        error: (error: any) => {

          // print the error
          console.error('Error processing data:', error, error.message)
          // set the error message to show on the screen by snackbar popup
          this.errorMessage = error.message || 'Error processing data. Please check console for details.'

          this.latestTaskId.set(null)
          this.isSeederProcessing = false
          
          // this.closeResults()

          // show snackbar Error
          this.showSnackbar(this.errorMessage || "", SnackBarType.error, '', 5000)
          this.cdr.markForCheck()
        }
      })


  }


  abortRequests() {
    const taskId = this.latestTaskId()

    console.log("cancel task by id ", taskId)
    if (!taskId || this.abortButtonPressed)
      return


    // Emit a signal to cancel the request
    this.destroy$.next()
    // this.crawlSubscription?.unsubscribe()
    this.abortButtonPressed = true

    // send cancel job request
    this.cancelSubscription = this.crawlService.cancelTask(taskId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res: { status: string, message: string }) => {
          switch (res.status) {
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
          this.abortButtonPressed = this.isSeederProcessing = false
          this.enableForm()
          console.log("an error occured on cancelation process: ", error)
        },
        complete: () => {

          this.abortButtonPressed = this.isSeederProcessing = false
          this.enableForm()
        }
      })
  }

  addCrawlResult(line: CrawlStreamBatch) {
    if (!line) return

    if (line.status === "ok") {
      this.handleOkChunk(line)
    } else if (line.status === "error" && line.message) {
      this.handleError(line.message)
    }
  }

  private handleOkChunk(chunk: CrawlStreamBatch) {
    if (chunk.chunk_index === '0' && this.batchStringBuffer) {
      this.processBatchBuffer(chunk.message)
    }

    if (chunk.type === 'batch_chunk' && chunk.dump && typeof chunk.dump === 'string') {
      this.batchStringBuffer += chunk.dump
    }

    if (chunk.message === "completed") {
      this.processBatchBuffer("completed")
    }
  }

  private processBatchBuffer(message?: string) {
    try {
      const dump: SeederResult = JSON.parse(this.batchStringBuffer)
      this.results.push({
        ...dump
      })
    } catch (error) {
      console.error("Failed to parse dump JSON:", error)
      this.showSnackbar("Error parsing seeder result data.", SnackBarType.error, '', 5000)
    } finally {
      this.batchStringBuffer = ''
    }
  }

  private handleError(message: string) {
    console.error("Error chunk received:", message)
    this.errorMessage = message
    this.showSnackbar(message, SnackBarType.error, '', 5000)
  }
  private disableForm() {
    this.researchForm.disable()
  }

  private enableForm() {
    this.researchForm.enable()
  }

  private closeResults() {

    this.destroy$.next()
    this.latestTaskId.set(null)

    this.taskStatus$ = of(undefined)

    this.abortButtonPressed = false
    this.progress = null
    this.batchStringBuffer = '' // reset the batch string buffer

    this.seederSubscription?.unsubscribe()
    this.cancelSubscription?.unsubscribe()
  }

  preparePayload(): SeederRequest {

    // Create a copy of the form value
    const formValue = this.researchForm.value

    // Prepare the request with proper domain values
    const request: SeederRequest = {
      domains: this.domains.controls.map(control => control.value),
      config: {
        ...formValue.config,
        // Ensure query is properly formatted (array in the model, string in the form)
        query: this.preProcessPayload(formValue.config?.query)
      },
      stream: formValue.stream
    }

    return request
  }

  private preProcessPayload(query: any) {

    const queries = query
      ? query.split(',').map((q: string) => q.trim()).filter((q: string) => q !== '')
      : []
    return queries
  }

  setupOperationData(domains: string[]): CrawlOperation {

    const operationData: CrawlOperation = {
      type: 'playground',
      author: {
        displayName: this.user?.currProviderData?.displayName || "anonymous",
        uid: this.user?.uid || "anonymous"
      },
      name: `Crawl Job - Playground`,
      created_At: Date.now(),
      scheduled_At: Date.now(),
      prompt: '',
      urlPath: this.router.url || 'unknown',
      metadataId: 'unknown',
      urls: domains || [],
      status: CrawlOperationStatus.READY,
      color: crawlOperationStatusColor(CrawlOperationStatus.READY),
    }

    return operationData
  }

  applyPreset(presetId: string): void {
    const preset = this.presets.find(p => p.id === presetId)
    if (!preset) return

    // Update active preset and form title
    this.activePreset = presetId
    this.formTitle = preset.label

    // Save selected preset to localStorage
    this.localStorage.setItem('domain-seeder-preset', JSON.stringify({ id: presetId }))

    // Expand the form when selecting a preset
    this.isExpanded = true
    this.localStorage.setItem('domain-seeder-expanded', 'true')

    // Get current form value
    const configGroup = this.researchForm.get('config')
    if (!configGroup) return
    // Reset domains
    while (this.domains.length) {
      this.domains.removeAt(0)
    }

    // Add example domains if available
    if (preset.exampleDomains && preset.exampleDomains.length > 0) {
      preset.exampleDomains.forEach(domain => {
        this.domains.push(this.fb.control(domain, [Validators.required, this.domainPatternValidator() as any]))
      })
    }

    // Apply each configuration property
    Object.entries(preset.config).forEach(([key, value]) => {
      const control = configGroup.get(key)
      if (control) {
        control.setValue(value)

        // Special handling for query field since it's used with chips
        if (key === 'query' && typeof value === 'string') {
          const queries = value.split(',').map(q => q.trim()).filter(q => q !== '')
          control.setValue(queries.join(','))
        }
      }
    })

    // Mark form as touched to trigger validation
    this.researchForm.markAllAsTouched()
  }
  // Reset form to default state
  resetForm(): void {
    this.activePreset = ''
    this.formTitle = 'DOMAIN_SEEDER.TITLE_DEFAULT'

    // Clear localStorage
    this.localStorage.removeItem('domain-seeder-preset')

    // Reset domains array
    while (this.domains.length) {
      this.domains.removeAt(0)
    }

    // Reset config values to defaults
    const configGroup = this.researchForm.get('config')
    if (configGroup) {
      configGroup.get('source')?.setValue('sitemap+cc')
      configGroup.get('pattern')?.setValue('*')
      configGroup.get('live_check')?.setValue(false)
      configGroup.get('extract_head')?.setValue(false)
      configGroup.get('max_urls')?.setValue(-1)
      configGroup.get('concurrency')?.setValue(1000)
      configGroup.get('hits_per_sec')?.setValue(5)
      configGroup.get('force')?.setValue(false)
      configGroup.get('base_directory')?.setValue('')
      configGroup.get('verbose')?.setValue(false)
      configGroup.get('query')?.setValue('')
      configGroup.get('score_threshold')?.setValue(0.3)
      configGroup.get('scoring_method')?.setValue('bm25')
      configGroup.get('filter_nonsense_urls')?.setValue(true)
    }

    // Reset stream value
    this.researchForm.get('stream')?.setValue(false)

     // remove results
    this.results = []
    
    this.closeResults()
  }

  // Get active preset information
  getActivePreset(): Preset | undefined {
    if (!this.activePreset) return undefined
    return this.presets.find(p => p.id === this.activePreset)
  }

  // Get a summary of preset configuration settings for display
  getPresetConfigSummary(): string {
    const preset = this.getActivePreset()
    if (!preset) return ''

    const config = preset.config
    const summaryParts = []

    if (config.source) summaryParts.push(`Source: ${config.source}`)
    if (config.scoring_method) summaryParts.push(`Scoring: ${config.scoring_method}`)
    if (config.score_threshold) summaryParts.push(`Threshold: ${config.score_threshold}`)
    if (config.max_urls) summaryParts.push(`Max URLs: ${config.max_urls}`)

    return summaryParts.join(' | ')
  }

  private setPresets() {

    this.presets.push({
      id: 'multi_domain_research',
      label: 'DOMAIN_SEEDER.PRESET_MULTI_LABEL',
      description: 'DOMAIN_SEEDER.PRESET_MULTI_DESC',
      config: {
        source: 'sitemap',
        extract_head: true,
        query: 'python beginner tutorial basics',
        scoring_method: 'bm25',
        score_threshold: 0.3,
        max_urls: 15,
        verbose: true
      },
      exampleDomains: [
        'python.org',
        'docs.python.org',
        'realpython.com'
      ]
    }, {
      id: 'comprehensive_validation',
      label: 'DOMAIN_SEEDER.PRESET_COMPREHENSIVE_LABEL',
      description: 'DOMAIN_SEEDER.PRESET_COMPREHENSIVE_DESC',
      config: {
        live_check: true,
        extract_head: true,
        max_urls: 50,
        concurrency: 10,
        scoring_method: 'bm25',
        query: 'tutorial',
        score_threshold: 0.2
      },
      exampleDomains: [
        'developer.mozilla.org',
        'web.dev'
      ]
    },
      {
        id: 'pattern_filtering',
        label: 'DOMAIN_SEEDER.PRESET_PATTERN_LABEL',
        description: 'DOMAIN_SEEDER.PRESET_PATTERN_DESC',
        config: {
          source: 'sitemap',
          pattern: '*/blog/2024/*.html',
          max_urls: 100
        },
        exampleDomains: [
          'medium.com',
          'dev.to',
          'hashnode.com'
        ]
      },
      {
        id: 'performance_tuning',
        label: 'DOMAIN_SEEDER.PRESET_PERF_LABEL',
        description: 'DOMAIN_SEEDER.PRESET_PERF_DESC',
        config: {
          source: 'cc',
          concurrency: 50,
          hits_per_sec: 20,
          max_urls: 10000,
          extract_head: false,
          filter_nonsense_urls: true
        }
      },
      {
        id: 'large_domain_processing',
        label: 'DOMAIN_SEEDER.PRESET_LARGE_LABEL',
        description: 'DOMAIN_SEEDER.PRESET_LARGE_DESC',
        config: {
          source: 'cc+sitemap',
          live_check: true,
          concurrency: 50,
          max_urls: 100000,
          extract_head: false,
          filter_nonsense_urls: true
        }
      },
      {
        id: 'metadata_extraction',
        label: 'DOMAIN_SEEDER.PRESET_META_LABEL',
        description: 'DOMAIN_SEEDER.PRESET_META_DESC',
        config: {
          live_check: true,
          extract_head: true,
          max_urls: 100
        }
      }, {
      id: 'relevance_scoring',
      label: 'DOMAIN_SEEDER.PRESET_RELEVANCE_LABEL',
      description: 'DOMAIN_SEEDER.PRESET_RELEVANCE_DESC',
      config: {
        source: 'sitemap',
        extract_head: true,
        query: 'python async await concurrency',
        scoring_method: 'bm25',
        score_threshold: 0.3,
        max_urls: 20
      },
      exampleDomains: [
        'docs.python.org',
        'fastapi.tiangolo.com',
        'asyncio.readthedocs.io'
      ]
    },
      {
        id: 'url_based_scoring',
        label: 'DOMAIN_SEEDER.PRESET_URL_LABEL',
        description: 'DOMAIN_SEEDER.PRESET_URL_DESC',
        config: {
          source: 'sitemap',
          extract_head: false,
          query: 'machine learning tutorial',
          scoring_method: 'bm25',
          score_threshold: 0.2
        },
        exampleDomains: [
          'tensorflow.org',
          'pytorch.org',
          'scikit-learn.org'
        ]
      },
      {
        id: 'complex_queries',
        label: 'DOMAIN_SEEDER.PRESET_COMPLEX_LABEL',
        description: 'DOMAIN_SEEDER.PRESET_COMPLEX_DESC',
        config: {
          source: 'sitemap',
          extract_head: true,
          query: 'data science pandas numpy visualization, web scraping automation selenium, machine learning tensorflow pytorch, api documentation rest graphql',
          scoring_method: 'bm25',
          score_threshold: 0.4,
          max_urls: 200
        }
      },
      {
        id: 'url_validation',
        label: 'DOMAIN_SEEDER.PRESET_VALIDATION_LABEL',
        description: 'DOMAIN_SEEDER.PRESET_VALIDATION_DESC',
        config: {
          live_check: true,
          concurrency: 15,
          hits_per_sec: 8,
          max_urls: 200,
          extract_head: true,
          verbose: true
        }
      })
  }

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

  /**
     * Important Functions
     */
  // 'info' | 'success' | 'warning' | 'error'
  private showSnackbar(
    message: string,
    type: SnackBarType = SnackBarType.info,
    action: string | '' = '',
    duration: number = 3000) {

    this.snackbarService.showSnackbar(message, type, action, duration)
  }

  ngOnDestroy(): void {
    // Cleanup is handled automatically by takeUntilDestroyed
    this.results = []
    this.closeResults()
    this.destroy$.complete()
  }
}
