import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostBinding, effect, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormsModule, Validators } from '@angular/forms';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { TranslateModule } from '@ngx-translate/core';
import { MarkdownModule } from 'ngx-markdown';
import { Observable } from 'rxjs/internal/Observable';
import { Subscription } from 'rxjs/internal/Subscription';
import { forkJoin } from 'rxjs/internal/observable/forkJoin';
import { of } from 'rxjs/internal/observable/of';
import { catchError } from 'rxjs/internal/operators/catchError';
import { map } from 'rxjs/internal/operators/map';
import { switchMap } from 'rxjs/internal/operators/switchMap';
import { ClipboardbuttonComponent } from 'src/app/core/components/clipboardbutton/clipboardbutton.component';
import { DropdownComponent } from 'src/app/core/components/dropdown/dropdown.component';
import { AiToolCall, ToolCallResolution, ToolCallResult, accumulateAnthropic, accumulateOpenAi, anthropicToolTurns, availableTools, finishToolCalls, newToolCallAccumulator, openaiToolTurns, resolveToolCall, sessionOwning } from 'src/app/core/functions';
import { FormControlPipe } from 'src/app/core/pipes';
import { AiAPIService, AiFetchService, AiModelsService, BucketStorageService, DeploymentService, SearchService, WebrainToolsService } from 'src/app/core/services';
// Not in the services barrel: every existing consumer imports it direct, so this follows them.
import { BrowserSessionService } from 'src/app/core/services/browser-session.service';
// Not in the barrel either -- the barrel exports `./billing.service`, not this one.
import { BillingPolicyService } from 'src/app/core/services/billing-policy.service';
// The account's own tier, which is a different question from the cap above: the cap is what
// the customer WILL spend, this is what their plan ENTITLES them to.
import { BillingService } from 'src/app/core/services/billing.service';
// Reused rather than restated: this is the same predicate the AI key resolution gates on, so
// a tier the key panel calls paid cannot be a tier the tool list calls free.
import { isPaidPlan } from 'src/app/core/types/ai-provider.interface';
import { LocalStorage } from 'src/app/core/services/storage.service';
import { AIModel, AiVendorId, SERP_DEFAULTS, SerpEngine, vendorForModelCode } from 'src/app/core/types';
import { DEFAULT_SYSTEM_PROMPT } from 'src/app/core/variables';

/**
 * What a tool returned, as the transcript shows it.
 *
 * The MODEL gets the whole answer (`toolResultText`, capped at `TOOL_RESULT_LIMIT`); this is
 * the user's half, and the two are deliberately different shapes. Enough to see WHICH routes
 * ran and how much came back, without pasting a scraped page into the bubble.
 *
 * `summary` is a measurement rather than a paraphrase: naming a payload's fields here would be
 * this component inventing a second vocabulary for something it does not own, which is the
 * drift `refusalText` and `webrain-tools.interface.ts` both refuse to commit.
 */
export interface ToolRun {
    readonly name: string;
    readonly summary: string;
}

export interface ChatMessage {
    /**
     * Stable identity.
     *
     * The template tracks by this rather than `$index`, and that is a correctness fix rather
     * than a style choice: stop and retry both SPLICE the array, and an index is not an
     * identity across a splice.
     */
    readonly id: string;
    readonly role: 'user' | 'assistant';
    readonly content: string;
    /** Epoch millis, so a resumed transcript can say how old it is. */
    readonly at: number;
    /**
     * The tool runs that fed this turn.
     *
     * Optional, and dropped by `buildHistory` -- which maps `{role, content}` explicitly, so a
     * tool result can never be replayed to the model as though the user had said it.
     */
    readonly tools?: readonly ToolRun[];
}

/**
 * Why a turn failed, at the granularity a user can act on.
 *
 * `auth`, `payment` and `rate` are three different next actions (fix your key, change plan,
 * wait), and the old single boolean told the user none of them. The BFF already has a
 * payment-required interceptor for the same reason.
 */
export type ChatFailureKind = 'auth' | 'payment' | 'rate' | 'network' | 'server';

export interface ChatFailure {
    readonly kind: ChatFailureKind;
    /** The transport's own words. Never translated: this is a diagnostic, not copy. */
    readonly detail: string;
}

export interface ChatRequest {
    /**
     * The transport dialect. `claude` is Anthropic's own protocol; `openai` is the shape
     * every other vendor speaks, including the caller's own endpoint.
     */
    provider: 'claude' | 'openai';
    /**
     * Which vendor, which is what decides the endpoint and the key.
     *
     * Separate from `provider` because `provider` is a PROTOCOL and this is a COMPANY:
     * nine vendors share the `openai` shape, and the model list a model id was picked from
     * is the only thing that says which one it belongs to. Anthropic is the one vendor where
     * the two collapse, and it is spelled out here rather than inferred.
     */
    vendor: AiVendorId;
    messages: Array<{ role: string; content: string }>;
}

/**
 * Transcript -> provider payload.
 *
 * Drops blank turns (a failed stream leaves an empty assistant message behind, and the
 * Claude API rejects an empty `content`), and maps down to `role`/`content` so the UI
 * shape can gain fields without leaking them into the request body.
 *
 * Takes `Pick<ChatMessage, 'role' | 'content'>` rather than a whole `ChatMessage`: this reads
 * exactly those two fields, and saying so keeps a caller holding only a partial turn from
 * having to invent an id and a timestamp to be allowed to ask.
 *
 * Exported and pure so the spec can pin it without standing up the component.
 */
export function buildHistory(
    messages: readonly Pick<ChatMessage, 'role' | 'content'>[],
    prompt: string,
): Array<{ role: string; content: string }> {
    return [...messages, { role: 'user' as const, content: prompt }]
        .filter(message => message.content.trim().length > 0)
        .map(({ role, content }) => ({ role, content }));
}

/**
 * Which API the picked model belongs to, and the messages to hand it.
 *
 * `app-llm-scrape` routes on the model's `code` the same way. The one subtlety:
 * `sendToOpenAI` ignores its `sys` argument as soon as it is given an array, so on the
 * OpenAI/Groq path the system turn has to travel *inside* the array. Claude takes
 * `system` as a top-level body field instead.
 *
 * Exported and pure so the spec can pin it without standing up the component.
 */
export function buildRequest(
    modelCode: string,
    messages: Array<{ role: string; content: string }>,
    system: string,
): ChatRequest {
    if (modelCode === 'claude') {
        return { provider: 'claude', vendor: 'anthropic', messages };
    }

    return {
        provider: 'openai',
        // The code names the vendor for every vendor except Anthropic, and a code the table
        // does not know is one of OpenAI's own -- see `vendorForModelCode`.
        vendor: vendorForModelCode(modelCode) ?? 'openai',
        messages: [{ role: 'system', content: system }, ...messages],
    };
}

/**
 * AI chat. Streams against `AiAPIService`, which already accepts a message array and
 * reports deltas — no new service, no new dependency.
 */
@Component({
    selector: 'app-chatai',
    imports: [FormsModule, MatProgressSpinner, MarkdownModule, TranslateModule, DropdownComponent, FormControlPipe],
    templateUrl: './chatai.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChataiComponent {
    @HostBinding('class') classes = 'grow flex flex-col min-h-0';

    /** ngx-markdown's clipboard directive wants the component type, not an instance. */
    readonly clipboardButton = ClipboardbuttonComponent;

    private readonly aiModels = inject(AiModelsService);

    /**
     * The models this dropdown offers, and the vendors it has none for.
     *
     * Owned by `AiModelsService` because three pickers share this list and must agree on it -- it
     * is the decision that sets whose model a request is posted to. The list arrives in two passes
     * (the static fallback, then each vendor's live catalogue), which is why it is a signal at
     * all: an array mutated after the first render never reaches an OnPush template.
     */
    readonly models = this.aiModels.models;
    readonly unlistedVendors = this.aiModels.unlistedVendors;

    readonly modelAI = new FormControl<AIModel>(
        // An initial value only. It is repaired against the real list the moment the list moves,
        // because a dropdown whose value is not among its options renders with NOTHING selected.
        { name: 'claude-haiku-5-5', code: 'claude' },
        { nonNullable: true, validators: [Validators.required] },
    );

    private readonly ai = inject(AiAPIService);
    private readonly tools = inject(WebrainToolsService);
    private readonly serp = inject(SearchService);
    private readonly scraper = inject(AiFetchService);
    private readonly sessions = inject(BrowserSessionService);
    private readonly storage = inject(BucketStorageService);
    /** The customer's own spend cap, so the chat can act on it like the settings page can. */
    private readonly billing = inject(BillingPolicyService);
    /** The caller's plan, for the one tool whose availability depends on it. */
    private readonly billingAccount = inject(BillingService);
    private readonly deployment = inject(DeploymentService);
    private readonly destroyRef = inject(DestroyRef);
    /**
     * Where the transcript is kept between reloads.
     *
     * The platform-guarded TOKEN rather than `window.localStorage`: it resolves to a
     * no-op store when the browser blocks storage, and during SSR, which is why this
     * needs no `isPlatformBrowser` guard of its own.
     */
    private readonly local = inject(LocalStorage);
    private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

    readonly messages = signal<ChatMessage[]>([]);
    readonly draft = signal('');
    readonly streaming = signal(false);

    /**
     * Why the last turn failed, or null.
     *
     * A KIND rather than a boolean, because "your key was rejected", "you are out of credits"
     * and "you are going too fast" are three different things for the user to do next, and the
     * old single flag told them none of them.
     */
    readonly failure = signal<ChatFailure | null>(null);

    /**
     * The round in flight, held so `stop()` can drop it.
     *
     * `takeUntilDestroyed` fires on DESTROY, which is not the same decision: a reply that
     * rambles or loops bills to completion, so cancelling has to be something the user can do
     * mid-stream rather than only by navigating away.
     */
    private active: Subscription | null = null;

    /**
     * The tool running right now, or empty.
     *
     * A chip rather than a transcript turn: it is transient UI state, and a turn would
     * have to be excluded from the history handed back to the model on the next send.
     * The raw tool name is shown, not prose -- identifiers like `search` are not
     * translated, the same way a model id is not.
     */
    readonly toolRunning = signal('');

    /**
     * The batch waiting for approval, or null.
     *
     * Non-null means the loop is PARKED: nothing is in flight, the transcript has
     * not moved, and the calls will not run until the user decides. Rendering it
     * is what makes the ARGUMENTS visible, and the visible arguments are the real
     * control -- the click only records the decision.
     */
    readonly pending = signal<PendingToolBatch | null>(null);

    // The platform default, from the one constant the service also falls back to -- see
    // `DEFAULT_SYSTEM_PROMPT`. This used to be a second copy of the same sentence.
    private readonly system = DEFAULT_SYSTEM_PROMPT;

    /**
     * Whether the caller's access mode is a paid one.
     *
     * A field rather than a read at the call site because the offer list is built while
     * streaming, and the tool it gates (`vision`) is a paid ROUTE: offering it to a free
     * caller hands the model a tool that reliably 402s and teaches it to retry, while
     * withholding it from a paying caller denies them a tool that would work.
     *
     * Starts false, which is the conservative direction for the window before the billing
     * document answers.
     */
    private paid = false;

    constructor() {
        this.aiModels.load();

        // Named for the account rather than `billing`, which this class already uses for the
        // spend cap. Same source as every other tier decision on the client.
        this.billingAccount
            .getAccessMode$()
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(mode => this.paid = isPaidPlan(mode));

        // A reload keeps the conversation. Restored BEFORE the effects below, so a stored
        // turn is painted by the same pass that would have painted a fresh one -- and it
        // cannot resurrect a reply, because `streaming` starts false either way.
        this.messages.set(this.restoreTranscript());

        // Repairs the selection every time the list moves. Not cosmetic: the list is filled in two
        // passes, and a selection that is not among its options leaves the dropdown blank.
        effect(() => {
            this.models();
            this.modelAI.setValue(this.aiModels.selectionFor(this.modelAI.value), { emitEvent: false });
        });

        // Keeps the newest token in view while a reply streams. `scroller()` is undefined
        // during SSR, so this stays browser-only without touching `document`.
        effect(() => {
            this.messages();
            const element = this.scroller()?.nativeElement;
            if (element) {
                element.scrollTop = element.scrollHeight;
            }
        });
    }

    send(): void {
        const prompt = this.draft().trim();
        if (!prompt || this.streaming()) {
            return;
        }

        this.draft.set('');
        this.submit(prompt);
    }

    /**
     * Stop the reply in flight.
     *
     * The partial answer is KEPT. A stopped reply is a shorter answer, not a lost one, and
     * throwing away what already arrived would make stopping feel like a punishment for
     * pressing it. What IS dropped is a turn that produced nothing, because an empty assistant
     * bubble is only a spinner and would spin forever.
     */
    stop(): void {
        this.active?.unsubscribe();
        this.active = null;
        this.finish();
    }

    /**
     * Ask the last question again, discarding the answer it got.
     *
     * One action rather than two, because "retry" after a failure and "regenerate" after an
     * answer the user did not want are the same operation on the transcript: drop everything
     * from the last user turn onward and submit it again. The button is labelled by whichever
     * state the user is actually in.
     */
    retry(): void {
        if (this.streaming()) {
            return;
        }

        const list = this.messages();

        // A loop rather than `findLastIndex`/`at`, which need a newer `lib` than this project
        // pins. The transcript is short and this runs once per click.
        let start = -1;
        for (let index = list.length - 1; index >= 0; index--) {
            if (list[index].role === 'user') {
                start = index;
                break;
            }
        }

        if (start < 0) {
            return;
        }

        const prompt = list[start].content;

        this.messages.set(list.slice(0, start));
        this.submit(prompt);
    }

    /**
     * Keep the transcript where a reload can find it.
     *
     * Called at the two TURN BOUNDARIES -- when the question is asked and when the
     * answer ends -- and never per streamed delta, which would stringify the whole
     * array on every token. A store that refuses (full, disabled, private mode) is
     * swallowed: losing the cache is not worth failing a reply the user already paid for.
     * @return {void}
     */
    private persistTranscript(): void {
        try {
            this.local.setItem(
                TRANSCRIPT_KEY,
                JSON.stringify(this.messages().slice(-TRANSCRIPT_MAX)),
            );
        } catch {
            // Deliberately silent. Serialising our own array cannot fail for a reason the
            // user could act on, so a line here would be noise in a console nobody reads.
        }
    }

    /**
     * The stored transcript, or an empty one.
     *
     * Every failure is an empty transcript rather than a throw: this runs inside the
     * constructor, where an exception would leave the page unable to render at all. A
     * malformed value is either something a previous version wrote or something the user
     * edited, and "start empty" is the honest answer to both.
     * @return {ChatMessage[]} The turns that could be read back.
     */
    private restoreTranscript(): ChatMessage[] {
        let raw: string | null = null;

        try {
            raw = this.local.getItem(TRANSCRIPT_KEY);
        } catch {
            return [];
        }

        if (!raw) {
            return [];
        }

        try {
            const parsed: unknown = JSON.parse(raw);

            if (!Array.isArray(parsed)) {
                return [];
            }

            const restored: ChatMessage[] = [];

            for (const value of parsed) {
                const message = toChatMessage(value);
                if (message) {
                    restored.push(message);
                }
            }

            return restored;
        } catch {
            return [];
        }
    }

    /**
     * Start a new conversation.
     *
     * Stops any reply in flight FIRST: clearing the transcript does not cancel the
     * request, and a stream whose target bubble has been removed would go on appending
     * to a turn nobody can see. The stored copy is removed rather than overwritten, so
     * this leaves nothing of the old conversation on the device.
     * @return {void}
     */
    newChat(): void {
        this.stop();
        this.messages.set([]);
        this.failure.set(null);

        try {
            this.local.removeItem(TRANSCRIPT_KEY);
        } catch {
            // Same reasoning as `persistTranscript`: not an error anyone can act on.
        }
    }

    /**
     * Send a prompt and open a turn for its answer.
     *
     * Extracted from `send` because `retry` needs the identical path. A retried turn taking a
     * different route through this component would be a second definition of "what sending
     * means", which is how two definitions drift.
     * @param {string} prompt The user's question, already trimmed.
     * @return {void}
     */
    private submit(prompt: string): void {
        // Snapshot history BEFORE the empty assistant placeholder is pushed, otherwise the
        // streamed reply would be fed back to the model as its own prior turn.
        const request = buildRequest(
            this.modelAI.value.code,
            buildHistory(this.messages(), prompt),
            this.system,
        );

        this.messages.update(list => [
            ...list,
            { id: newId(), role: 'user', content: prompt, at: Date.now() },
            { id: newId(), role: 'assistant', content: '', at: Date.now() },
        ]);
        // The QUESTION is persisted here rather than at the end of the turn, so a reload
        // mid-answer keeps what the user typed. The empty placeholder goes in with it and
        // `toChatMessage` drops it on the way back out.
        this.persistTranscript();
        this.streaming.set(true);
        this.failure.set(null);

        // The array is the conversation the PROVIDER sees. It is extended in place once a
        // tool round adds turns, so the answering round reads the calls and their results
        // rather than being asked the original question again.
        this.stream(request, request.messages, true);
    }

    /**
     * One round against the picked provider.
     *
     * Streams even when a tool is offered, because a model that decides to call one
     * usually writes a sentence first, and a non-streaming round would freeze on it.
     * The trade is that a tool call has to be reassembled from fragments, which is what
     * the accumulator is for.
     *
     * `offerTools` is false on the answering round: offering them again would invite
     * another call instead of the answer the user is waiting for.
     * @param {ChatRequest} request Which dialect, and the turns to send.
     * @param {Array} messages The provider-side conversation, extended in place.
     * @param {boolean} offerTools Whether this round may call a tool.
     * @return {void}
     */
    private stream(
        request: ChatRequest,
        messages: Array<{ role: string; content: unknown }>,
        offerTools: boolean,
    ): void {
        const claude = request.provider === 'claude';
        const offered = offerTools ? availableTools(this.paid) : undefined;
        const accumulator = newToolCallAccumulator();

        // The vendor the model was picked from. The guard is for the TYPE rather than the
        // runtime: on this branch it is never Anthropic (that is `claude`), so an undefined
        // vendor here could only mean a code the table does not know -- and `sendToOpenAI`
        // then resolves from the name, as it always did.
        //
        // `jina` needs no clause: it is a scrape provider and is not in `AiVendorId`.
        const vendor = request.vendor === 'anthropic' ? undefined : request.vendor;

        const source = claude
            ? this.ai.sendToClaudeAI(messages, this.modelAI.value.name, this.system, offered)
            : this.ai.sendToOpenAI(messages, this.modelAI.value.name, undefined, offered, vendor);

        // Held on the instance so `stop()` can drop it. `takeUntilDestroyed` stays: navigating
        // away must still cancel the round, and unsubscribing twice is a no-op.
        this.active = source
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                // Each emission is a DELTA, not the accumulated text.
                next: chunk => {
                    // Claude reports a call as a raw SSE event, OpenAI as a delta on the
                    // chunk. The two accumulators are the only place that difference lives.
                    if (claude) {
                        if (chunk?.event) {
                            accumulateAnthropic(accumulator, chunk.event);
                        }
                    } else if (chunk?.toolCalls) {
                        accumulateOpenAi(accumulator, chunk.toolCalls);
                    }

                    this.appendToReply(chunk?.content ?? '');
                },
                error: (error: unknown) => this.fail(error),
                complete: () => {
                    // A round that ended is no longer cancellable, and leaving a settled
                    // subscription here would make the next `stop()` a no-op.
                    this.active = null;

                    const calls = finishToolCalls(accumulator);

                    if (!offerTools || calls.length === 0) {
                        this.finish();
                        return;
                    }

                    this.runTools(request, messages, calls);
                },
            });
    }

    /**
     * Execute the model's calls, then let it answer.
     *
     * ONE round, deliberately. A second round is a spend decision rather than a chat
     * feature: a model that keeps calling a tool would bill the caller per round with no
     * ceiling, and nothing here has one yet. This is the seam to widen when it does.
     * @param {ChatRequest} request Which dialect, and the turns to send.
     * @param {Array} messages The provider-side conversation, extended in place.
     * @param {AiToolCall[]} calls The calls to run, in the order the model emitted them.
     * @return {void}
     */
    private runTools(
        request: ChatRequest,
        messages: Array<{ role: string; content: unknown }>,
        calls: readonly AiToolCall[],
    ): void {
        // The gate. A batch containing anything that changes state is PARKED, not
        // run, and the calls are held exactly as the model emitted them.
        //
        // Per BATCH rather than per call, deliberately: a round either runs or it
        // waits. Running the reads and parking the writes would leave the
        // transcript holding half a round, so the model would answer from a
        // partial picture while the user is still deciding.
        const needsApproval = calls.some(call => {
            const resolution = resolveToolCall(call, this.paid);
            return resolution.ok && resolution.tool.requiresConfirm === true;
        });

        if (needsApproval) {
            this.pending.set({ request, messages, calls });
            return;
        }

        this.runBatch(request, messages, calls);
    }

    /**
     * Run every call and continue the loop with the results.
     *
     * Split out of `runTools` so the approved and unapproved paths are the SAME
     * code. A batch that needed a click must not reach execution by a different
     * route than one that did not.
     * @param {ChatRequest} request The request being answered.
     * @param {Array<{ role: string; content: unknown }>} messages The history.
     * @param {readonly AiToolCall[]} calls The calls to run.
     * @return {void}
     */
    private runBatch(
        request: ChatRequest,
        messages: Array<{ role: string; content: unknown }>,
        calls: readonly AiToolCall[],
    ): void {
        // `forkJoin` keeps the order `calls` declared, which matters: the results are
        // matched to the calls positionally by the turn builders.
        //
        // Held on the instance for the same reason `stream` holds it: a batch of browser
        // captures takes seconds, and `stop()` must cancel that too rather than only working
        // once the answer has begun.
        this.active = forkJoin(calls.map(call => this.execute(call))).subscribe({
            next: results => {
                messages.push(
                    ...(request.provider === 'claude'
                        ? anthropicToolTurns(calls, results)
                        : openaiToolTurns(calls, results)),
                );

                // What the tools returned, attached to the answer they fed. AFTER the
                // provider turns, so a failure building those cannot leave the user looking
                // at a result the model never saw.
                this.recordTools(results);

                this.toolRunning.set('');
                this.stream(request, messages, false);
            },
            error: (error: unknown) => this.fail(error),
        });
    }

    /**
     * Run the parked batch the user just approved.
     *
     * Passes `batch.calls` through untouched -- see `PendingToolBatch` for why
     * that is the whole point.
     */
    confirmPending(): void {
        const batch = this.pending();
        if (!batch) {
            return;
        }

        this.pending.set(null);
        this.runBatch(batch.request, batch.messages, batch.calls);
    }

    /**
     * Decline the parked batch.
     *
     * The model gets a synthetic result for every call rather than silence, so it
     * can answer the user instead of stalling. Told not to retry, because a model
     * that re-asks produces the same prompt again -- which reads as a bug to the
     * user who has already said no.
     */
    cancelPending(): void {
        const batch = this.pending();
        if (!batch) {
            return;
        }

        this.pending.set(null);

        const declined = batch.calls.map(call => ({
            call,
            content:
                `The user declined to run "${call.name}". Do not retry it; ` +
                'ask what they would prefer instead.',
        }));

        batch.messages.push(
            ...(batch.request.provider === 'claude'
                ? anthropicToolTurns(batch.calls, declined)
                : openaiToolTurns(batch.calls, declined)),
        );

        this.stream(batch.request, batch.messages, false);
    }

    /**
     * A call's arguments, untruncated, for the approval prompt.
     *
     * JSON rather than a sentence: the model chose these keys, so naming them in
     * prose here would be this component inventing a second vocabulary for
     * something it does not own. Untruncated is load-bearing -- an approval that
     * hides part of what it approves is a rubber stamp, which is the exact failure
     * this path exists to prevent.
     * @param {AiToolCall} call The parked call.
     * @return {string} The arguments as indented JSON.
     */
    protected argsText(call: AiToolCall): string {
        return JSON.stringify(call.args ?? {}, null, 2);
    }

    /**
     * Run one call and reduce it to the text the model gets back.
     *
     * Never errors, from either branch. A refused call and a failed route are both
     * ANSWERS the model can act on ("that tool is unavailable"), and letting either
     * reject would abort the whole round -- so one flaky tool would kill a transcript
     * that could have carried on. `resolveToolCall` runs first, because the name and the
     * arguments are model output: untrusted input at a trust boundary, and nothing
     * reaches a route because a model asked.
     * @param {AiToolCall} call One call as the model emitted it.
     * @return {Observable<ToolCallResult>} The call paired with its result text.
     */
    private execute(call: AiToolCall): Observable<ToolCallResult> {
        const resolution = resolveToolCall(call, this.paid);

        if (!resolution.ok) {
            return of({ call, content: refusalText(resolution) });
        }

        this.toolRunning.set(resolution.tool.name);

        const args = resolution.call.args;
        const route = resolution.tool.name;

        const source = this.dispatch(route, args);

        return source.pipe(
            map(envelope => ({ call, content: toolResultText(envelope) })),
            catchError((error: unknown) =>
                of({ call, content: `The tool "${route}" failed: ${failureLine(error)}` }),
            ),
        );
    }

    /**
     * Which service answers a tool name.
     *
     * A switch rather than a lookup table, because each route takes a DIFFERENT
     * argument shape and goes through a different existing service -- the payload is
     * the reason these cannot be collapsed into one generic call.
     *
     * Every branch reuses the service the UI already uses, so the route's own guard
     * (`paid`, `perm(...)`) is the only thing deciding access. Nothing here widens
     * what a caller may do; a refusal simply arrives as an error the model can read.
     * @param {string} route The resolved tool name.
     * @param {Record<string, unknown>} args The arguments the model supplied.
     * @return {Observable<unknown>} The route's reply.
     */
    private dispatch(
        route: string,
        args: Record<string, unknown>,
    ): Observable<unknown> {
        switch (route) {
            case 'search':
                return this.tools.search({ ...args });
            case 'serp':
                return this.serp.search({
                    ...SERP_DEFAULTS,
                    query: String(args['query'] ?? ''),
                    ...(args['engine'] ? { engine: args['engine'] as SerpEngine } : {}),
                });
            case 'scrape':
                return this.scraper.scrape(String(args['url'] ?? ''));
            case 'list_sessions':
                return this.sessions.list();
            case 'list_storage':
                return this.storage.list();
            case 'list_machines':
                return this.deployment.listMine();
            /**
             * The three browser-escalation tools. `guide` takes no arguments on
             * the worker; the other two forward verbatim and let the route
             * refuse a bad argument with a 400 the model can read, which is the
             * same division of labour `search` uses above.
             */
            case 'guide':
                return this.tools.guide();
            case 'navigate':
                return this.tools.navigate({ ...args });
            case 'observe':
                return this.tools.observe({ ...args });
            /**
             * Dispatched precisely BECAUSE the offer gate was widened to paid callers.
             *
             * `offerTools` and this switch are two separate lists with nothing connecting
             * them, so widening one without the other produces a tool that reads as
             * available and then answers "No dispatcher for the tool" -- the offer would
             * be a lie. Forwarded verbatim like `navigate`: the route is behind the `paid`
             * guard, so an unpicked caller is refused by the ROUTE, and a bad `op` comes
             * back as a 400 the model can read.
             */
            case 'vision':
                return this.tools.vision({ ...args });
            /**
             * The write tools. These only ever reach here through `confirmPending`
             * -- `runTools` parks any batch that contains one, so an unapproved call
             * cannot arrive at this branch.
             */
            case 'stop_session':
                return this.sessions.close(String(args['session_id'] ?? ''));
            case 'stop_machine':
                return this.machineAction('stop', String(args['machine_id'] ?? ''));
            case 'suspend_machine':
                return this.machineAction('suspend', String(args['machine_id'] ?? ''));
            /**
             * Idempotent on the server: a key that is already gone is a success
             * rather than a 404, so a model calling this twice gets an answer it
             * can act on instead of an error it will try to work around.
             */
            case 'delete_file':
                return this.storage.remove(String(args['key'] ?? ''));
            case 'save_file':
                /**
                 * `url` is required by the schema and `filename` is not, so the optional
                 * field is spread rather than passed as `undefined`: the request type
                 * tells "absent" apart from "present but empty", and the server names
                 * the object from the URL when it is absent.
                 */
                return this.storage.save({
                    url: String(args['url'] ?? ''),
                    ...(args['filename'] ? { filename: String(args['filename']) } : {}),
                });
            case 'set_spend_cap': {
                /**
                 * Checked here rather than forwarded. The route rejects a non-integer,
                 * and rounding a float behind the user's back would set a cap they did
                 * not approve -- on the one tool whose whole job is to bound spend. A
                 * refusal the model can read is the only honest outcome.
                 */
                const cap = Number(args['spend_cap_credits']);
                if (!Number.isInteger(cap) || cap < 0) {
                    return of({
                        error:
                            'spend_cap_credits has to be a whole number of credits, ' +
                            '0 or more, where 0 means no cap. Ask the user which ' +
                            'number they want.',
                    });
                }
                return this.billing.set({ spendCapCredits: cap });
            }
            /**
             * The one tool with no route, so it answers from the component itself.
             *
             * It sets the SAME control the user's own dropdown sets, which means the
             * change is visible in the picker instead of hidden in a preference -- the
             * only reason a model choosing a model is acceptable: the user watches it
             * happen, and `requiresConfirm` made them approve it first.
             *
             * Matched on `name`, NOT `code`. `AIModel.code` is the VENDOR (`claude`,
             * `openai`) and is shared by every model from that vendor, so matching on
             * it would silently select whichever model happened to be first.
             *
             * A miss is refused WITH the list, because the list is dynamic -- it
             * arrives in two passes and varies by vendor -- so no static description
             * can enumerate it. A refusal the model can read is what lets it correct
             * itself instead of guessing again.
             */
            case 'set_model': {
                const wanted = String(args['model'] ?? '').trim();
                const list = this.models();
                const match = list.find(model => model.name === wanted);

                if (!match) {
                    return of({
                        error:
                            `"${wanted}" is not one of the models this account can use. ` +
                            `Choose one of: ${list.map(model => model.name).join(', ')}.`,
                    });
                }

                this.modelAI.setValue(match);
                return of({ model: match.name, vendor: match.code });
            }
            default:
                return of({ error: `No dispatcher for the tool "${route}".` });
        }
    }

    /**
     * Run a machine action, unless a session owns the machine.
     *
     * The guard is here because of what stopping a session's machine actually does: the
     * session RECORD survives and `chargeSessionMeter` bills from the record, so the
     * customer would keep paying to their ceiling with nothing left to connect to. That
     * is the hazard `refuseSessionOwnedAction` guards on the machines page, and the two
     * call the SAME predicate -- one rule with two callers rather than two rules.
     *
     * A refusal is prose for the MODEL rather than a thrown error, so the round can
     * recover: it is told which session to end instead of being handed a dead end.
     * @param {'stop'|'suspend'} action Which action the model asked for.
     * @param {string} machineId The machine the model named.
     * @return {Observable<unknown>} The route's reply, or a refusal it can act on.
     */
    private machineAction(
        action: 'stop' | 'suspend',
        machineId: string,
    ): Observable<unknown> {
        if (!machineId) {
            return of({ error: 'No machine id was given. Call list_machines first.' });
        }

        return this.deployment.listMine().pipe(
            switchMap(reply => {
                const owner = sessionOwning(machineId, reply.machines ?? []);

                if (owner) {
                    return of({
                        error:
                            `The machine "${machineId}" belongs to browser session ` +
                            `"${owner}". Stopping the machine would leave that session ` +
                            'billing with nothing to connect to. Call stop_session with ' +
                            'that session id instead.',
                    });
                }

                return action === 'stop'
                    ? this.deployment.stopMachine(machineId)
                    : this.deployment.suspendMachine(machineId);
            }),
        );
    }

    /**
     * Close the current turn: not streaming, no tool chip, no empty bubble left behind.
     *
     * One place rather than three, because `stop`, `fail` and a completed round have to agree
     * about what "this turn is over" means. The logic this replaces only dropped the empty
     * placeholder on the FAILURE path, so a cancelled round would have left a spinner forever.
     * @return {void}
     */
    private finish(): void {
        this.toolRunning.set('');
        this.streaming.set(false);

        this.messages.update(list => {
            const last = list[list.length - 1];

            // A turn with tool runs but no prose is KEPT: those routes were paid for, and
            // dropping the bubble would throw away the only record that they ran.
            return last && last.role === 'assistant' && !last.content && !last.tools?.length
                ? list.slice(0, -1)
                : list;
        });

        // AFTER the update, so a turn this function just dropped is not the turn that gets
        // stored -- otherwise a reload would resurrect the empty bubble it removed.
        this.persistTranscript();
    }

    /**
     * The tool runs a batch produced, attached to the assistant turn they fed.
     *
     * Attached to the existing assistant message rather than pushed as its own turn, for two
     * reasons: `buildHistory` maps `{role, content}`, so a tool turn in the transcript would
     * otherwise be replayed to the model as though the user had said it; and the provenance
     * belongs to the answer it produced, which is where a reader looks for it.
     * @param {readonly ToolCallResult[]} results The results, in the order the calls were declared.
     * @return {void}
     */
    private recordTools(results: readonly ToolCallResult[]): void {
        const runs: ToolRun[] = results.map(result => ({
            name: result.call.name,
            summary: summariseToolResult(result.content),
        }));

        this.messages.update(list => {
            const last = list[list.length - 1];

            if (!last || last.role !== 'assistant') {
                return list;
            }

            return [
                ...list.slice(0, -1),
                { ...last, tools: [...(last.tools ?? []), ...runs] },
            ];
        });
    }

    private fail(error: unknown): void {
        console.error('AI chat stream failed:', error);

        this.active = null;
        this.failure.set(failureOf(error));
        this.finish();
    }

    onKeydown(event: KeyboardEvent): void {
        // Enter sends, Shift+Enter inserts a newline.
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            this.send();
        }
    }

    private appendToReply(delta: string): void {
        if (!delta) {
            return;
        }

        this.messages.update(list => {
            const last = list[list.length - 1];
            if (!last || last.role !== 'assistant') {
                return list;
            }

            return [...list.slice(0, -1), { ...last, content: last.content + delta }];
        });
    }
}

/**
 * A model turn parked until the user approves it.
 *
 * The `calls` are held VERBATIM, and that is the point rather than a detail. An
 * approval names specific arguments, so whatever runs afterwards has to be the
 * thing that was shown. Re-deriving the call from the model on resume would open
 * a window in which a page fetched in between rewrites the arguments under a
 * consent the user already gave -- and nothing about the UI would look
 * different.
 */
export interface PendingToolBatch {
    readonly request: ChatRequest;
    readonly messages: Array<{ role: string; content: unknown }>;
    readonly calls: readonly AiToolCall[];
}

/** How much of a route's answer the model is shown. */
const TOOL_RESULT_LIMIT = 6000;

/**
 * Where the transcript is kept between reloads, and how much of it.
 *
 * Versioned, because the stored shape may change and an older value has to be
 * recognisable rather than misread. Capped, because this is a CACHE in a ~5MB budget
 * and not the record of the conversation: the newest turns are what a reload is for,
 * so the oldest are the right thing to lose. It is deliberately local to ONE browser
 * -- there is no cross-device history, and adding one means Firestore plus a
 * retention decision rather than another line here.
 */
const TRANSCRIPT_KEY = 'deepscrape.chat.v1';
const TRANSCRIPT_MAX = 40;

/** Whether a stored value is a tool run the chip can render. */
const isToolRun = (value: unknown): value is ToolRun => {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const run = value as Partial<ToolRun>;
    return typeof run.name === 'string' && typeof run.summary === 'string';
};

/**
 * A stored entry as a turn, or null when it is not one.
 *
 * The value comes out of localStorage, which the user and any script on this origin can
 * write, so it is UNTRUSTED input rather than our own output coming back. Every field
 * the template reads is checked, and the provenance is re-validated rather than trusted
 * -- a hand-edited `tools: [{}]` would otherwise reach the chip.
 *
 * An empty assistant turn is null: that is the in-flight placeholder, which means
 * nothing once the page is gone, and `finish` drops it for the same reason.
 * @param {unknown} value One entry of the stored array.
 * @return {ChatMessage | null} The turn, or null when it cannot be rendered.
 */
const toChatMessage = (value: unknown): ChatMessage | null => {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const entry = value as Partial<ChatMessage>;
    const tools = Array.isArray(entry.tools) ? entry.tools.filter(isToolRun) : [];

    if (typeof entry.id !== 'string' || typeof entry.content !== 'string') {
        return null;
    }

    if (entry.role !== 'user' && entry.role !== 'assistant') {
        return null;
    }

    if (typeof entry.at !== 'number') {
        return null;
    }

    if (entry.role === 'assistant' && !entry.content && !tools.length) {
        return null;
    }

    return { id: entry.id, role: entry.role, content: entry.content, at: entry.at, tools };
};

/**
 * A route's answer as text for the model, capped.
 *
 * JSON rather than a per-route summary: the three envelopes carry three different
 * payloads, and naming their fields here would be exactly the drift
 * `webrain-tools.interface.ts` refuses to commit. The cap is the point -- one scrape of
 * a large page would otherwise spend the whole context window on a single tool result,
 * and the caller pays for that again on the next round.
 *
 * Exported and pure so the spec can pin it without standing up the component.
 */
export function toolResultText(envelope: unknown): string {
    const text = JSON.stringify(envelope) ?? '';

    return text.length > TOOL_RESULT_LIMIT
        ? text.slice(0, TOOL_RESULT_LIMIT) + '… [truncated]'
        : text;
}

/**
 * Why a call was refused, as something the model can act on.
 *
 * Addressed to the model rather than the user, so it is English prose and not a
 * translation key -- the rule the tool descriptions already follow. A refusal that said
 * only "error" would leave the model with no way to correct itself, which is the whole
 * reason this path exists instead of silently dropping the call.
 *
 * Exported and pure so the spec can pin it.
 */
export function refusalText(
    resolution: Extract<ToolCallResolution, { ok: false }>,
): string {
    switch (resolution.reason) {
        case 'unknown-tool':
            return `There is no tool named "${resolution.name}". Call only the tools you were offered.`;
        case 'not-offered':
            return notOfferedText(resolution);
        default:
            return `The arguments for "${resolution.name}" could not be read. Send valid JSON.`;
    }
}

/**
 * Why a tool that EXISTS cannot be used by this caller, as one line for the model.
 *
 * A switch rather than one sentence, because the four remedies are different and the model
 * is the only thing positioned to pass the right one on: an upgrade fixes `plan`, opening
 * a browser session fixes `session`, and the other two are nobody's to fix. "The tool is
 * not available here" is true in all four cases and useful in none of them -- it either
 * talks the user out of a capability they could have had, or promises an upgrade that
 * would not have helped.
 * @param {ToolCallResolution} resolution The refused resolution.
 * @return {string} The line to hand back to the model.
 */
export function notOfferedText(
    resolution: Extract<ToolCallResolution, { ok: false }>,
): string {
    switch (resolution.block) {
        case 'plan':
            return `The tool "${resolution.name}" needs a paid plan, which this account does not have. Tell the user it requires an upgrade, and do not retry it.`;
        case 'session':
            return `The tool "${resolution.name}" needs a dedicated browser session, which chat cannot give it. Tell the user to open one and drive it there, and do not retry it.`;
        case 'spend':
            return `The tool "${resolution.name}" is withheld in chat because it bills the platform's own key. Tell the user plainly, and do not retry it.`;
        default:
            return `The tool "${resolution.name}" is not available in chat. Tell the user, and do not retry it.`;
    }
}

/** A transport failure as one line, for the model. */
function failureLine(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Monotonic fallback for `newId`, and only that. */
let idCounter = 0;

/**
 * A transcript id.
 *
 * `crypto.randomUUID` is guarded rather than assumed: it needs a secure context, and this is
 * the same defensive shape `device-verification.service.ts` already uses for the same call. The
 * counter is a fallback for a non-secure origin, not a second identity scheme.
 * @return {string} A value unique within this session.
 */
function newId(): string {
    idCounter += 1;

    return globalThis.crypto?.randomUUID?.() ?? `m${idCounter}`;
}

/**
 * Which class of failure a transport error is.
 *
 * Exported and pure so the spec can pin the mapping without standing up the component: which
 * status lands in which bucket is the part that decides what the user is told to do.
 * @param {unknown} error Whatever the stream rejected with.
 * @return {ChatFailure} The kind, and the transport's own words.
 */
export function failureOf(error: unknown): ChatFailure {
    const status = typeof error === 'object' && error !== null && 'status' in error
        ? Number((error as { status?: unknown }).status)
        : NaN;

    return { kind: kindForStatus(status), detail: failureLine(error) };
}

/**
 * The status -> kind map.
 *
 * `402` is separated from the rest of the 4xx range because this platform bills credits and the
 * BFF already carries a payment-required interceptor for it -- "add credits" and "your key was
 * rejected" are different instructions, and a single boolean gave the user neither. `0` is what
 * the browser reports for a request that never arrived.
 * @param {number} status The HTTP status, or NaN when there was no response at all.
 * @return {ChatFailureKind} The class to show copy for.
 */
function kindForStatus(status: number): ChatFailureKind {
    if (status === 401 || status === 403) {
        return 'auth';
    }

    if (status === 402) {
        return 'payment';
    }

    if (status === 429) {
        return 'rate';
    }

    if (status === 0) {
        return 'network';
    }

    return 'server';
}

/**
 * How much a tool returned, as the number the transcript shows beside its name.
 *
 * A measurement rather than a preview. A preview of a scraped page is either useless or a leak
 * into a transcript that gets persisted, and the size is the thing a user can act on: it says
 * whether a route came back with a page or with a refusal, and how close it ran to the cap the
 * model is shown.
 * @param {string} text The result text, as the model received it.
 * @return {string} The character count.
 */
export function summariseToolResult(text: string): string {
    return `${text.length}`;
}
