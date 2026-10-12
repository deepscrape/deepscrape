import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostBinding, effect, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormsModule, Validators } from '@angular/forms';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { TranslateModule } from '@ngx-translate/core';
import { MarkdownModule } from 'ngx-markdown';
import { Observable } from 'rxjs/internal/Observable';
import { forkJoin } from 'rxjs/internal/observable/forkJoin';
import { of } from 'rxjs/internal/observable/of';
import { catchError } from 'rxjs/internal/operators/catchError';
import { map } from 'rxjs/internal/operators/map';
import { ClipboardbuttonComponent } from 'src/app/core/components/clipboardbutton/clipboardbutton.component';
import { DropdownComponent } from 'src/app/core/components/dropdown/dropdown.component';
import { AiToolCall, ToolCallResolution, ToolCallResult, accumulateAnthropic, accumulateOpenAi, anthropicToolTurns, availableTools, finishToolCalls, newToolCallAccumulator, openaiToolTurns, resolveToolCall } from 'src/app/core/functions';
import { FormControlPipe } from 'src/app/core/pipes';
import { AiAPIService, AiFetchService, AiModelsService, BucketStorageService, DeploymentService, SearchService, WebrainToolsService } from 'src/app/core/services';
// Not in the services barrel: every existing consumer imports it direct, so this follows them.
import { BrowserSessionService } from 'src/app/core/services/browser-session.service';
import { AIModel, AiVendorId, SERP_DEFAULTS, SerpEngine, vendorForModelCode } from 'src/app/core/types';

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
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
 * Exported and pure so the spec can pin it without standing up the component.
 */
export function buildHistory(
    messages: readonly ChatMessage[],
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
    private readonly deployment = inject(DeploymentService);
    private readonly destroyRef = inject(DestroyRef);
    private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

    readonly messages = signal<ChatMessage[]>([]);
    readonly draft = signal('');
    readonly streaming = signal(false);
    readonly failed = signal(false);

    /**
     * The tool running right now, or empty.
     *
     * A chip rather than a transcript turn: it is transient UI state, and a turn would
     * have to be excluded from the history handed back to the model on the next send.
     * The raw tool name is shown, not prose -- identifiers like `search` are not
     * translated, the same way a model id is not.
     */
    readonly toolRunning = signal('');

    private readonly system = "You are deepscrape's assistant. Reply in concise markdown.";

    constructor() {
        this.aiModels.load();

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

        // Snapshot history BEFORE the empty assistant placeholder is pushed, otherwise the
        // streamed reply would be fed back to the model as its own prior turn.
        const request = buildRequest(
            this.modelAI.value.code,
            buildHistory(this.messages(), prompt),
            this.system,
        );

        this.messages.update(list => [
            ...list,
            { role: 'user', content: prompt },
            { role: 'assistant', content: '' },
        ]);
        this.draft.set('');
        this.streaming.set(true);
        this.failed.set(false);

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
        const offered = offerTools ? availableTools() : undefined;
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

        source
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
                    const calls = finishToolCalls(accumulator);

                    if (!offerTools || calls.length === 0) {
                        this.streaming.set(false);
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
        // `forkJoin` keeps the order `calls` declared, which matters: the results are
        // matched to the calls positionally by the turn builders.
        forkJoin(calls.map(call => this.execute(call))).subscribe({
            next: results => {
                messages.push(
                    ...(request.provider === 'claude'
                        ? anthropicToolTurns(calls, results)
                        : openaiToolTurns(calls, results)),
                );

                this.toolRunning.set('');
                this.stream(request, messages, false);
            },
            error: (error: unknown) => this.fail(error),
        });
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
        const resolution = resolveToolCall(call);

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
            default:
                return of({ error: `No dispatcher for the tool "${route}".` });
        }
    }

    private fail(error: unknown): void {
        console.error('AI chat stream failed:', error);
        // Drop the empty placeholder, or the transcript keeps a spinner forever.
        this.messages.update(list =>
            list[list.length - 1]?.content ? list : list.slice(0, -1),
        );
        this.toolRunning.set('');
        this.failed.set(true);
        this.streaming.set(false);
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

/** How much of a route's answer the model is shown. */
const TOOL_RESULT_LIMIT = 6000;

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
            return `The tool "${resolution.name}" is not available here. Answer without it.`;
        default:
            return `The arguments for "${resolution.name}" could not be read. Send valid JSON.`;
    }
}

/** A transport failure as one line, for the model. */
function failureLine(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
