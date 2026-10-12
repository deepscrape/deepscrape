import { ChangeDetectionStrategy, Component, DestroyRef, HostBinding, effect, inject, signal, ViewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, FormControl, FormGroup, Validators } from '@angular/forms';
import { Observable } from 'rxjs/internal/Observable';
import { forkJoin } from 'rxjs/internal/observable/forkJoin';
import { of } from 'rxjs/internal/observable/of';
import { delay } from 'rxjs/internal/operators/delay';
import { mergeMap } from 'rxjs/internal/operators/mergeMap';
import { Subscription } from 'rxjs/internal/Subscription';
import {
  arrayBufferToString, calculateOpenAICost, chatInBatchesAI, constructCookiesforJina,
  crawlOperationStatusColor,
  extractDomain, formatBytes, sanitizeJSON,
} from 'src/app/core/functions';
import { aichunk, AIModel, BrowserConfigurationImpl, CrawlConfig, CrawlerRunConfigImpl, CrawlOperation, CrawlPack, CrawlTask, OpenAITokenDetails, AiKeySource, AiVendorId, vendorForModelCode } from '../../types';
import { GinputComponent } from '../ginput/ginput.component';
import { AiAPIService, AiFetchService, AiKeysService, AiModelsService, LocalStorage, SnackbarService } from '../../services';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { TranslateModule } from '@ngx-translate/core';

import { MarkdownModule } from 'ngx-markdown';
import { ClipboardbuttonComponent } from '../clipboardbutton/clipboardbutton.component';
import { PromptareaComponent } from '../promptarea/promptarea.component';
import { DropdownComponent } from '../dropdown/dropdown.component';
import { FormControlPipe } from "../../pipes";
import { BrowserCookiesComponent } from '../cookies/cookies.component';
import { SnackBarType } from '../snackbar/snackbar.component';
import { RadioToggleComponent } from '../radiotoggle/radiotoggle.component';
import { takeUntil } from 'rxjs/internal/operators/takeUntil';
import { Subject } from 'rxjs/internal/Subject';
import { CrawlOperationStatus } from '../../enum';
import { concatMap } from 'rxjs/internal/operators/concatMap';
import { map } from 'rxjs/internal/operators/map';

interface TokenUsage {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  [key: string]: number | null | undefined;
}

type AIRole = 'user' | 'assistant' | 'system';

interface AIMessage {
  content: string;
  usage: TokenUsage | null;
  role: AIRole | null;
}

/** What the results panel shows under the reply. Two numbers, both computed. */
interface LlmUsage {
  total_tokens: number;
  total_cost: number;
}

@Component({
  selector: 'app-llm-scrape',
  imports: [MatIcon, MarkdownModule, MatProgressSpinner, GinputComponent, PromptareaComponent, DropdownComponent, FormControlPipe, RadioToggleComponent, BrowserCookiesComponent, TranslateModule],
  templateUrl: './app-llm-scrape.component.html',
  styleUrl: './app-llm-scrape.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppLLMScrapeComponent {
  @HostBinding('class') classes = 'flex items-center flex-col relative';

  readonly clipboardButton = ClipboardbuttonComponent;
  private localStorage: Storage
  url: FormControl<string>

  userprompt: FormControl<string>

  submitButton: FormControl<boolean>

  /**
   * The reply so far, accumulated as the stream arrives.
   *
   * Signals rather than plain fields because the update happens inside a
   * subscription callback: with `OnPush` and no zone, a plain field would change
   * without anything telling the view to re-read it, and the panel would stay
   * blank until some unrelated event triggered a check. This component has no
   * `ChangeDetectorRef` for exactly that reason.
   */
  protected readonly content = signal('')

  /** Tokens and cost for the reply, or null before the provider reports them. */
  protected readonly usage = signal<LlmUsage | null>(null)

  protected readonly isResultsProcessing = signal(false)
  protected readonly isCrawlProcessing = signal(false)
  protected readonly isGetResults = signal(false)
  protected readonly errorMessage = signal('')

  /**
   * The vendor whose key served the current request.
   *
   * Set when the request starts and rendered beside the reply, because BYOK
   * today means "your own quota on a paid plan": a user who has stored a key
   * cannot otherwise tell whether their key or the platform's was spent, and
   * the answer is a server decision the UI has to report rather than guess.
   */
  protected readonly activeVendor = signal<AiVendorId | null>(null)

  forkJoinSubscription: Subscription
  aiResultsSub: Subscription

  private readonly destroyRef = inject(DestroyRef)

  private readonly aiModels = inject(AiModelsService)

  /**
   * The models the dropdown offers.
   *
   * Owned by `AiModelsService` because three pickers share this list and must agree on it:
   * `DropdownComponent` renders whatever it is given, so a model the caller cannot actually
   * call would be a 402 the moment it was picked.
   */
  readonly models = this.aiModels.models

  modelAI: FormControl<AIModel>


  options: FormGroup

  private aiapi = inject(AiAPIService)
  private aiFetch = inject(AiFetchService)
  private aiKeys = inject(AiKeysService)
  private snackbarService = inject(SnackbarService)
  private fb = inject(FormBuilder)

  constructor() {
    // Fills the model list AND reads the vendor catalogue the "which key served this" badge
    // needs -- the service loads the keys itself, so the explicit `aiKeys.load()` that used to
    // sit here would only buy a second round trip on the one page that shows both.
    this.aiModels.load()
    this.localStorage = inject(LocalStorage)

    // Repairs the selection whenever the list moves. Not cosmetic: the list arrives in two
    // passes (static, then live), and a selection that is not among its options leaves the
    // dropdown rendering with NOTHING selected. `modelAI` is built in a later lifecycle step, so
    // the first pass of this effect can run before it exists.
    effect(() => {
      this.models()
      if (!this.modelAI) {
        return
      }
      this.modelAI.setValue(this.aiModels.selectionFor(this.modelAI.value), { emitEvent: false })
    })
  }

  ngOnInit(): void {
    this.isResultsProcessing.set(false)
    this.isCrawlProcessing.set(false)
    this.isGetResults.set(false)
    this.errorMessage.set('')

    //Called after the constructor, initializing input properties, and the first call to ngOnChanges.
    //Add 'implements OnInit' to the class.
    this.url = new FormControl('', {
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

    // Must be a model the list actually offers, or the dropdown renders with NOTHING selected.
    // This matched a model `setAIModel` had stopped shipping since the vendor expansion, so the
    // picker opened blank; the selection effect in the constructor repairs it from then on.
    this.modelAI = new FormControl<{ name: string, code: string }>({ name: 'claude-haiku-5-5', code: "claude" }, {
      // updateOn: 'blur', //default will be change
      nonNullable: true,
      validators: [
        Validators.required
      ]
    })

    this.options = this.fb.group({
      forwardCookies: new FormControl<boolean>(this.localStorage.getItem("forwardCookies") === "true", {
        // updateOn: 'change', //default will be change
        nonNullable: true,
        validators: [
          Validators.required
        ]
      }),
      // Enable iframe Extraction
      // Extracts and processes content from all embedded iframes within the DOM tree
      iframeEnable: new FormControl<boolean>(true, {
        // updateOn: 'change', //default will be change
        validators: [
          Validators.required,
        ]
      })
    })

    // `forEach` used to be used here, which subscribes and never unsubscribes:
    // one leaked subscription per component instance, writing to localStorage
    // for a preference nobody was reading any more. `takeUntilDestroyed` is what
    // the rest of the repository uses for a subscription with no mid-life
    // cancellation requirement. This one has none: the preference is a stored
    // value, and it is also written by the cookies component.
    this.forwardCookies?.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value: boolean) => {
        this.localStorage.setItem("forwardCookies", String(value))
        // this.browserCookies.closeModal = !value
      })
  }

  protected get forwardCookies() {
    return this.options.get('forwardCookies')
  }

  protected get iframeEnable() {
    return this.options.get('iframeEnable')
  }

  /**
   * Where the key for the call to the currently selected model would come from.
   *
   * Read from the server's resolved state through `AiKeysService`, not computed
   * from the model name here: the server is what chooses the credential, and a
   * second opinion in the browser would be a second answer.
   * @return {AiKeySource} `user`, `platform`, or `none`.
   */
  protected activeKeySource(): AiKeySource {
    const vendor = this.activeVendor()
    return vendor ? this.aiKeys.resolve(vendor).source : 'none'
  }

  /**
   * The i18n key for the key source of the call that produced the reply.
   * @return {string} The translation key.
   */
  protected activeKeySourceLabelKey(): string {
    switch (this.activeKeySource()) {
      case 'user':
        return 'AI_VENDOR.SOURCE_USER'
      case 'platform':
        return 'AI_VENDOR.SOURCE_PLATFORM'
      default:
        return 'AI_KEYS.SOURCE_NONE'
    }
  }


  protected onDropDownSelected($event: Event) {
    // throw new Error('Method not implemented.');
  }

  protected onDataLinkChange(event: Event) {
    // const input = event.target as EventTarget & HTMLInputElement
    // go to the focus to the next text input, textarea
  }

  protected onPromptSubmited(prompt: string) {

    console.log('Crawl Operation Started', this.url.value, this.userprompt.value, this.modelAI.value.code, prompt, this.modelAI.valid, this.url.valid, this.userprompt.valid)

    // return an error message if url or userpormpt is invalid
    if (!this.url.valid || !this.userprompt.valid || !this.modelAI.valid)
      return

    // reset the results
    this.closeResults()

    // disable the form
    this.disableForm()

    // start the crawl operation
    this.isCrawlProcessing.set(true)

    // live processing
    this.processData(this.url.value, this.modelAI.value.code)
  }

  /**
   * The page text for one target, fetched through the worker's free route.
   *
   * Why `/api/scrape` and not the crawl path
   * ---------------------------------------
   * The route is behind `crawl.execute`, not `paid`, so any authenticated
   * caller reaches it and the page read costs no crawl credits. That is what
   * makes the LLM step usable on a free plan, which matters because the vendor
   * routes are paid-gated: a free user with their own key can still get a page
   * read and a completion out of this, and could not if the fetch went through
   * `/api/crawl`.
   *
   * A refused or failed fetch is thrown rather than returned as an empty
   * string: an empty body sent to a model produces a confident answer about
   * nothing, which is worse than an error the user can see.
   * @param {string} url The target to read.
   * @return {Observable<string>} The page text, or an error.
   */
  private fetchPageContent(url: string): Observable<string> {
    return this.aiFetch.scrape(url).pipe(
      map((envelope) => {
        if (envelope.status === 'error') {
          throw new Error(envelope.error || 'AI_FETCH.UNREACHABLE')
        }
        return envelope.data?.result?.text ?? ''
      })
    )
  }


  private processData(link: string, aitype: string = 'claude') {

    this.errorMessage.set('')

    // Recorded before the request so the reply can say whose key would have
    // served it. The source itself is read from the server's resolved state at
    // render time, so a key stored while the reply streams is reflected.
    this.activeVendor.set(vendorForModelCode(aitype))

    const urls = [
      link
    ]

    // Page content comes from the scraping worker. Cookie forwarding and iframe
    // extraction are not part of this chain: `/api/scrape` accepts `url` and
    // nothing else, so a forwarded cookie would be an argument the worker
    // ignores, and the toggle stays for the crawl path it still governs.
    const tasks = urls.map((url, index) =>
      of(null).pipe(
        delay(index * 200), // Increasing delay for each request
        mergeMap(() => this.fetchPageContent(url))
      )
    )

    // fork join the links
    this.forkJoinSubscription = forkJoin(tasks)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (results: string[]) => {
          const subsequentContent = results.map((result: string) => {
            const encoder = new TextEncoder()
            const bytesLength = encoder.encode(result).length;
            console.log(formatBytes(bytesLength))
            return result
          })

          const subsequentPosts: Observable<AIMessage>[] = []

          const role: string = aitype === 'claude' ? 'user' : 'system'
          for (const content of subsequentContent) {
            const messages: { role: string; content: string }[] = []

            messages.push({ role, content: sanitizeJSON(this.userprompt.value.replace(/\n+/gi, '')) })

            chatInBatchesAI(messages, content)
            console.log(messages)

            subsequentPosts.push(of(null).pipe(
              mergeMap(() => this.chooseAIModel(messages))
            ))
          }

          const arrayobs = subsequentPosts.shift() || null
          if (!arrayobs)
            return

          this.getResultsFromAI([arrayobs])
        },
        complete: () => {
          // reset the processing status
          this.isCrawlProcessing.set(false)
          // reset the form
          this.enableForm()
        },
        error: (error: unknown) => {

          // print the error
          const errorDetails = error && typeof error === 'object' ? (error as any).error : undefined;
          console.error('Error processing data:', error, errorDetails ? arrayBufferToString(errorDetails) : 'Unknown error');
          // set the error message to show on the screen by snackbar popup
          this.errorMessage.set('Error processing data. Please check console for details.');

          // reset the processing status
          this.isResultsProcessing.set(false)
          this.isCrawlProcessing.set(false)
          // show snackbar Error
          this.showSnackbar(this.errorMessage() || "", SnackBarType.error, '', 5000)
        }
      })
  }

  private chooseAIModel(messages: { role: string; content: string }[]) {
    const modelAI = this.modelAI.value.code

    switch (modelAI) {
      case 'openai':
        return this.sendBatchToOpenAI(messages)
        break
      case 'groq':
        return this.sendBatchToOpenAI(messages)
        break
      case 'claude':
        return this.sendToClaudeAi(messages)
        break
      default:
        return this.sendToClaudeAi(messages)
        break
    }
  }

  private sendBatchToOpenAI(messages: { role: string; content: string }[]):
    Observable<AIMessage> {

    return this.aiapi.sendToOpenAI(messages, this.modelAI.value.name)

  }

  private sendToClaudeAi(messages: { role: string; content: string }[]):
    Observable<AIMessage> {

    return this.aiapi.sendToClaudeAI(messages, this.modelAI.value.name, "you are a nice assistant").pipe(
      map((response: any) => ({
        content: response.content,
        usage: response.usage || null,
        role: response.role || ('assistant' as AIRole)
      } as AIMessage))
    )
  }


  private getResultsFromAI(subsequentPosts: Observable<AIMessage>[]) {

    /* Initialize the Results viariables  */
    this.errorMessage.set('')
    this.isGetResults.set(true)
    this.isResultsProcessing.set(true)

    // init the total cost and total tokens counter
    let total_cost = 0
    let total_tokens = 0

    // The provider's stream, cancelled either by the component's destruction or
    // by `abortRequests`, which unsubscribes `aiResultsSub` and thereby aborts
    // the in-flight HTTP request rather than leaving it to complete unseen.
    this.aiResultsSub = subsequentPosts[0]
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(
        {
          next: (result: AIMessage) => {

            this.content.update(previous => previous + (result.content || ''))

            if (result?.usage) {
              const rawUsage = result.usage as unknown as TokenUsage;
              // Bracket access throughout: `TokenUsage` carries an index
              // signature, so dot access is a compile error under
              // `noPropertyAccessFromIndexSignature` even though the keys exist.
              total_tokens = !rawUsage?.['total_tokens'] ?
                (rawUsage?.['completion_tokens'] || 0) + (rawUsage?.['prompt_tokens'] || 0) :
                rawUsage?.['total_tokens'] || 0

              // The second cast is deliberate, not a shortcut:
              // `calculateOpenAICost` predates `TokenUsage` and takes the older,
              // fully named `OpenAITokenDetails`, which the index-signature type
              // is not assignable to. Both describe the same payload.
              //
              // The live facts are passed in so the price comes from the vendors'
              // own published rates rather than the table inside this function,
              // whose own comment says several of its rows are guesses. Absent
              // facts are normal -- the registry does not carry every vendor -- and
              // the table is the fallback, not the answer.
              total_cost = calculateOpenAICost(
                rawUsage as unknown as OpenAITokenDetails,
                this.modelAI.value.name,
                this.aiModels.factsFor(this.modelAI.value.name),
              )

              this.usage.set({ total_tokens, total_cost })
            }
          },
          complete: () => {

            // reset all variables to zero
            this.isResultsProcessing.set(false)

            // reset the form
            this.enableForm()
          },
          error: (error) => {

            console.error('Error sending data to AI:', error)
            this.errorMessage.set('Error on get data from AI. Please check console for details.')

            // show show Snackbar
            this.showSnackbar(this.errorMessage() || "", SnackBarType.error, '', 5000)

            // reset all variables to zero
            this.isResultsProcessing.set(false);

            // reset the form
            this.enableForm()
          }
        }
      )
  }

  enableForm() {

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

  protected closeResults() {

    // Close results, reset results variables and subscribers
    this.isGetResults.set(false)
    this.usage.set(null)
    this.content.set('')
    this.aiResultsSub?.unsubscribe()
    this.forkJoinSubscription?.unsubscribe()
  }
  // 'info' | 'success' | 'warning' | 'error'
  showSnackbar(
    message: string,
    type: SnackBarType = SnackBarType.info,
    action: string | '' = '',
    duration: number = 3000) {

    this.snackbarService.showSnackbar(message, type, action, duration)
  }

  onClearText() {
    this.url.setValue('')
  }

  abortRequests() {

    // Unsubscribing is the cancellation: Angular's HttpClient aborts the
    // underlying request when its subscription is disposed, so this stops the
    // provider stream and the page fetch at the transport rather than leaving
    // them running with nobody listening.
    this.aiResultsSub?.unsubscribe()
    this.forkJoinSubscription?.unsubscribe()
    this.isResultsProcessing.set(false)
    this.isCrawlProcessing.set(false)
    this.enableForm()
    this.showSnackbar('Request canceled', SnackBarType.info, '', 5000)
  }

  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.
    // Unsubscribe the streams. `takeUntilDestroyed` already covers the two
    // subscriptions it guards; this covers a request that was aborted earlier
    // and re-created, and keeps destruction independent of which mechanism
    // created the subscription.
    this.aiResultsSub?.unsubscribe()
    this.forkJoinSubscription?.unsubscribe()
  }
}

