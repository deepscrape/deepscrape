import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { DatePipe, Location, NgTemplateOutlet } from '@angular/common';
import { Router } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormsModule, Validators } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { TranslateModule } from '@ngx-translate/core';
import { MarkdownModule } from 'ngx-markdown';
import { Observable } from 'rxjs/internal/Observable';
import { Subscription } from 'rxjs/internal/Subscription';
import { forkJoin } from 'rxjs/internal/observable/forkJoin';
import { of } from 'rxjs/internal/observable/of';
import { from } from 'rxjs/internal/observable/from';
import { firstValueFrom } from 'rxjs/internal/firstValueFrom';
import { catchError } from 'rxjs/internal/operators/catchError';
import { switchMap } from 'rxjs/internal/operators/switchMap';
import { map } from 'rxjs/internal/operators/map';
import { ClipboardbuttonComponent } from 'src/app/core/components/clipboardbutton/clipboardbutton.component';
// The app's own ripple, the one 60 other components already press. Material's `MatRipple` is a
// second, differently-shaped ripple on the same product, so the chat uses this one or none.
import { RippleDirective } from 'src/app/core/directives';
import { AiToolCall, AiToolSpec, ToolCallResolution, ToolCallResult, accumulateAnthropic, accumulateOpenAi, anthropicToolTurns, availableTools, finishToolCalls, jobRequest, newToolCallAccumulator, openaiToolTurns, resolveToolCall, sessionOwning } from 'src/app/core/functions';
import { AiAPIService, AiFetchService, AiModelsService, AuthService, AuthzService, BucketStorageService, ChatRailService, CrawlAPIService, CrawlStoreService, DeploymentService, SearchService, WebrainToolsService } from 'src/app/core/services';
// Same helper every sidebar, nav and tab link uses to build an org-scoped url.
import { orgScopedUrl } from 'src/app/core/guards/host-routing.policy';
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
import { CrawlOperation } from 'src/app/core/types';
import { CrawlOperationStatus } from 'src/app/core/enum';
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
 *
 * `status` is the one thing an agent step log showed that this transcript did not. A refused call
 * and a route that failed both became ordinary result text, so every chip rendered identically and
 * the amber failure line named no call. It carries that WITHOUT carrying the payload, which the
 * paragraph above refuses.
 */
export type ToolRunStatus = 'ok' | 'refused' | 'failed';

export interface ToolRun {
    readonly name: string;
    readonly summary: string;
    readonly status: ToolRunStatus;
}

/** One executed call: the text the model got, plus how it went for the human reading it. */
export interface ExecutedCall extends ToolCallResult {
    readonly status: ToolRunStatus;
}

/**
 * Tokens one turn spent, normalised across vendors.
 *
 * Three numbers and no price: a price needs a per-model rate table this client does not own, and
 * inventing one would be the same lie as showing a deadline we cannot keep. Tokens are what the
 * vendor actually reports.
 */
export interface TokenUsage {
    readonly input: number;
    readonly output: number;
    /** Of `input`, how many were served from the vendor's prompt cache. */
    readonly cached: number;
}

/**
 * The usage object a streamed chunk carried, in one shape.
 *
 * Four spellings, because four vendors disagree: `prompt_tokens`/`completion_tokens` from the
 * OpenAI family, `input_tokens`/`output_tokens` from Claude's own message, and the cache count as
 * `prompt_tokens_details.cached_tokens` (OpenAI, Groq, Kimi, OpenRouter), `prompt_cache_hit_tokens`
 * (DeepSeek, which does not use the nested field at all), or `cache_read_input_tokens` (Anthropic,
 * carried through by `sendToClaudeAI` under its own name). Only READS count: an Anthropic cache
 * WRITE is billed at 1.25x and is not a saving, so `cache_creation_input_tokens` is deliberately
 * absent.
 *
 * Null rather than zeros when nothing is countable: a turn with no usage must render nothing, not
 * "0 in / 0 out".
 * @param {unknown} raw The `usage` a chunk carried, or nothing.
 * @return {TokenUsage | null} The counts, or null when the payload holds none.
 */
export function tokenUsage(raw: unknown): TokenUsage | null {
    const usage = raw as Record<string, unknown> | null | undefined;
    if (!usage || typeof usage !== 'object') {
        return null;
    }

    const count = (value: unknown): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : 0;

    const input = count(usage['prompt_tokens']) || count(usage['input_tokens']);
    const output = count(usage['completion_tokens']) || count(usage['output_tokens']);

    if (!input && !output) {
        return null;
    }

    const details = usage['prompt_tokens_details'] as Record<string, unknown> | undefined;

    return {
        input,
        output,
        cached: count(details?.['cached_tokens']) ||
            count(usage['prompt_cache_hit_tokens']) ||
            count(usage['cache_read_input_tokens']),
    };
}

/**
 * An image a turn carried, as storage filed it.
 *
 * Three fields and no URL. A presigned link is a five-minute bearer credential
 * (`PRESIGN_TTL_SECONDS`), so storing one would store a secret that both expires and fails; the
 * key is the durable fact and the link is minted per request by `replayImages`.
 */
export interface ChatMedia {
    readonly key: string;
    readonly mime: string;
    readonly name: string;
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
    /**
     * What the turn cost, as the vendor reported it.
     *
     * Absent on a turn that never reached a vendor, and on every transcript written before this
     * field existed -- which is why the template treats it as optional rather than defaulting it.
     */
    readonly usage?: TokenUsage;
    /**
     * The images this turn carried, by the object they were filed under.
     *
     * KEYS, not bytes: `localStorage` spends the same ~5 MB budget the whole transcript lives in,
     * so one stored image would evict the conversation it belongs to. A key is enough to mint a
     * fresh link when the turn is replayed, and a key that no longer resolves is a chip that says
     * the picture is gone rather than a request that fails.
     */
    readonly media?: readonly ChatMedia[];
}

/**
 * Why a turn failed, at the granularity a user can act on.
 *
 * `auth`, `payment` and `rate` are three different next actions (fix your key, change plan,
 * wait), and the old single boolean told the user none of them. The BFF already has a
 * payment-required interceptor for the same reason.
 */
export type ChatFailureKind = 'auth' | 'payment' | 'rate' | 'network' | 'server' | 'upstream';

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
    /**
     * The turns to send. `content` is `unknown` because a user turn carrying an image is a list of
     * content PARTS rather than a string, and the two dialects build different parts.
     */
    messages: Array<{ role: string; content: unknown }>;
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
    // `id` is optional because it is only needed to LOOK UP an image; a caller holding two fields
    // should not have to invent one to ask for a transcript.
    messages: readonly (Pick<ChatMessage, 'role' | 'content'> & { readonly id?: string })[],
    prompt: string,
    provider: 'claude' | 'openai' = 'openai',
    images: (id: string) => readonly RequestMedia[] = () => [],
): Array<{ role: string; content: unknown }> {
    const turns = [...messages, { id: '', role: 'user' as const, content: prompt }];

    return turns
        .filter(message => message.content.trim().length > 0)
        .map(({ id, role, content }) => {
            // The resolver is what makes a follow-up work: without it an image reached the vendor
            // once and every later turn asked about a picture the model could no longer see.
            const attached = id ? images(id) : [];

            return {
                role,
                content: attached.length ? filesInContent(provider, content, attached) : content,
            };
        });
}

/**
 * Which wire dialect a model code speaks.
 *
 * Two callers need this now (the request builder and the history builder), and a second copy of
 * `modelCode === 'claude'` is how the two would drift into disagreeing about the parts shape.
 * @param {string} modelCode The model id the picker chose.
 * @return {'claude'|'openai'} The dialect.
 */
export function providerFor(modelCode: string): 'claude' | 'openai' {
    return modelCode === 'claude' ? 'claude' : 'openai';
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
    messages: Array<{ role: string; content: unknown }>,
    system: string,
): ChatRequest {
    if (providerFor(modelCode) === 'claude') {
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
 * How close to the end still counts as "at the bottom", in CSS pixels.
 *
 * Not zero: `scrollHeight - scrollTop - clientHeight` is fractional at a non-integer device
 * pixel ratio, so an exact comparison reads as "scrolled up" on a transcript that is visibly
 * at the bottom -- and the follow effect below would then never follow again.
 */
export const BOTTOM_TOLERANCE_PX = 24;

/**
 * Whether a scroll container is showing its newest line.
 *
 * Takes the three measurements rather than an element so a spec can pin it with no DOM, and so
 * the element itself stays inside one component method.
 * @param {*} box The container's scrollHeight, scrollTop and clientHeight.
 * @return {boolean} True when the viewport is within BOTTOM_TOLERANCE_PX of the end.
 */
export function isAtBottom(
    box: { scrollHeight: number; scrollTop: number; clientHeight: number },
): boolean {
    return box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM_TOLERANCE_PX;
}

/**
 * What this turn is allowed to do.
 *
 * `agent` is the old behaviour and stays the default, so nothing changes for a caller who never
 * opens the menu. The other two are narrower, never wider, and that direction is the whole point:
 * a choice in a toolbar may only take capability away.
 */
export type ChatMode = 'ask' | 'plan' | 'agent';

/** How much reasoning the model may spend. `off` is only meaningful where a vendor has the field. */
export type ThinkEffort = 'default' | 'off' | 'low' | 'medium' | 'high';

/**
 * The tools a mode may offer.
 *
 * `requiresConfirm` IS the write boundary -- every route that changes account state sets it -- so
 * Plan is "everything that only reads" without a second list of tool names to keep in step. A
 * second list would drift the first time a tool was added to one and not the other.
 * @param {readonly AiToolSpec[]} tools What the caller's tier allows.
 * @param {ChatMode} mode The mode picked in the composer.
 * @return {readonly AiToolSpec[]} The subset this mode may offer the model.
 */
export function toolsForMode(
    tools: readonly AiToolSpec[],
    mode: ChatMode,
): readonly AiToolSpec[] {
    if (mode === 'ask') {
        return [];
    }

    return mode === 'plan' ? tools.filter(tool => tool.requiresConfirm !== true) : tools;
}

/**
 * Which vendor tab the model picker holds.
 *
 * Derived on every read rather than stored, because a stored choice can outlive the catalogue it
 * pointed at: tapping a tab whose catalogue came back empty left the list permanently empty and
 * the panel claiming to be loading forever. A vendor with no models is not a tab, so a stale
 * choice falls back to the selected model's vendor and then to the first one.
 * @param {readonly string[]} tabs The vendors the catalogue returned, in catalogue order.
 * @param {string} choice The vendor the user last tapped, if any.
 * @param {string} selected The vendor of the model currently selected.
 * @return {string} A vendor present in `tabs` whenever `tabs` is not empty.
 */
export function pickerTab(
    tabs: readonly string[],
    choice: string,
    selected: string,
): string {
    if (choice && tabs.includes(choice)) {
        return choice;
    }

    return tabs.includes(selected) ? selected : tabs[0] ?? selected;
}

/**
 * The body fields that turn reasoning on or off, for the vendors that document them.
 *
 * Two vendors, because the field is vendor-specific and a parameter a vendor does not know is a
 * 400 rather than a nudge. DeepSeek is the one that matters: it reasons by DEFAULT, and a request
 * carrying `tools` must then replay `reasoning_content` on every later round -- which this client
 * does not carry, so `off` is what keeps a tool round from failing. OpenAI's reasoning models take
 * `reasoning_effort`; every other model rejects it outright, hence the name gate rather than
 * sending it and hoping.
 *
 * shortcut: DeepSeek and OpenAI reasoning models only; the other vendors ignore this control.
 * Upgrade to a per-vendor capability table when one of them documents an equivalent.
 * @param {AiVendorId} vendor Which company answers the request.
 * @param {string} model The model id, for the one gate that depends on it.
 * @param {ThinkEffort} effort The value picked in the composer.
 * @return {Record<string, unknown>} Fields to spread into the request body.
 */
export function reasoningParams(
    vendor: AiVendorId,
    model: string,
    effort: ThinkEffort,
): Record<string, unknown> {
    // Anthropic's thinking is off unless explicitly enabled, so there is nothing to ask it for.
    if (effort === 'default' || vendor === 'anthropic') {
        return {};
    }

    if (vendor === 'deepseek') {
        return effort === 'off' ? { thinking: { type: 'disabled' } } : {};
    }

    // Gemini's OpenAI-compatible endpoint maps `reasoning_effort` onto its thinking levels, and
    // documents that it cannot be turned OFF on 2.5 Pro or the 3 family -- so `off` sends nothing
    // rather than a value that would be rejected. Omitting the field is the documented default.
    if (vendor === 'gemini') {
        return effort === 'off' ? {} : { reasoning_effort: effort };
    }

    return /^(o\d|gpt-5)/i.test(model) && effort !== 'off'
        ? { reasoning_effort: effort }
        : {};
}

/**
 * Vendors whose documentation says `response_format` is accepted.
 *
 * Two, deliberately. A vendor that does not take the field answers 400, so offering the switch
 * everywhere would turn a formatting preference into a failed turn on somebody else's key. Adding
 * one is a single entry here once that vendor's own guide says so -- which is the same standard
 * `27-ai-file-and-tool-capabilities.md` §2 holds every other vendor claim to.
 *
 * Anthropic is absent because it has no `response_format` at all: JSON there is a prompt, not a
 * parameter. OpenRouter and a caller's own endpoint are absent because support depends on the model
 * behind them, which this client cannot see.
 */
export const JSON_VENDORS: readonly AiVendorId[] = ['openai', 'deepseek'];

/**
 * The request fields that ask for a JSON answer, when the vendor can be asked.
 *
 * `json_object` guarantees the SHAPE and never the content: a model can still answer a question
 * that has nothing to do with JSON. And it guarantees nothing at all about the prose around it if
 * the prompt does not echo the requirement, which is what `JSON_NOTE` is for.
 * @param {boolean} json Whether the user asked for it.
 * @param {AiVendorId} vendor The vendor the request goes to.
 * @return {Record<string, unknown>} The fields, or {} when this vendor has none.
 */
export function formatParams(json: boolean, vendor: AiVendorId): Record<string, unknown> {
    return json && JSON_VENDORS.includes(vendor) ? { response_format: { type: 'json_object' } } : {};
}

/**
 * The extra system instruction a JSON turn carries.
 *
 * Both vendors require the word "json" in the prompt itself or they refuse the field, and DeepSeek's
 * guide adds that an example steers the shape. It rides on the SYSTEM prompt rather than on the
 * user's question so the transcript still shows what the user actually typed.
 *
 * Known limit: on a shape the model cannot produce, DeepSeek replaces the non-JSON text with spaces
 * and still reports `stop`, so the turn can arrive empty. That is the same blank answer as any other
 * and is handled by the existing "no answer" path rather than by a special case here.
 */
export const JSON_NOTE =
    'Reply with one valid JSON object and no surrounding prose. If the question has no natural ' +
    'JSON shape, wrap the answer in a single "answer" key.';

/** A file the user attached, already read. */
export interface ChatAttachment {
    readonly name: string;
    readonly text: string;
    /** True when the body was cut, so the chip can say so instead of lying about the size. */
    readonly truncated: boolean;
    /** The MIME type, for an image or a document. Absent on a text attachment. */
    readonly mime?: string;
    /** Where the bytes were filed, so the object outlives this tab. */
    readonly key?: string;
    /** The bytes as a `data:` URL, kept only in memory and only for this page's lifetime. */
    readonly dataUrl?: string;
}

/** Longest file body kept, in characters. Four of these is about a long article each. */
export const ATTACH_MAX_CHARS = 12000;

/** Files one message may carry. Beyond this the prompt stops being a question. */
export const ATTACH_MAX_FILES = 4;

/**
 * The most bytes one attached file may carry, decoded.
 *
 * 1 MiB, not the vendor limits in `27-ai-file-and-tool-capabilities.md`: the binding constraint is
 * the BFF's 8 MiB request body, and base64 spends 4/3 of it while the rest of the conversation
 * shares the remainder. One cap for images and documents rather than two, because `ATTACH_MAX_FILES`
 * of either is what that body budget was sized for.
 */
export const MEDIA_MAX_BYTES = 1024 * 1024;

/** The image types both vendors we can address accept. Anything else is refused, not guessed at. */
export const IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * The one document type a vendor we address can read, and only Claude can.
 *
 * A PDF is not an image with a different name on the wire: it is a `document` block, it needs
 * `media_type` beside the bytes, and every other vendor has no part that means it. A page is also
 * billed twice over by Anthropic -- text extracted AND rendered as an image -- so this is the one
 * attachment whose cost the user cannot guess from its size.
 */
export const PDF_TYPE = 'application/pdf';

/**
 * One attachment on its way to a vendor -- an image or a PDF.
 *
 * Two carriers, because there are two situations. A turn being sent NOW still holds its bytes, so
 * it travels inline as a `data:` URL and costs no round trip. A turn being REPLAYED after a reload
 * holds only a storage key, and the vendor fetches the URL itself -- which is why the replayed form
 * has to be a presigned https link and never a `blob:` one, since a blob URL exists only in this
 * document and a vendor's server cannot reach it.
 *
 * Anthropic says the same thing from the other side: an inline attachment is re-sent on every turn
 * of a conversation and "significantly increase[s] request size and latency". A PDF makes that worse
 * than an image, because every page is parsed before the first token is produced.
 */
export interface RequestMedia {
    readonly mime: string;
    /**
     * The file's own name, when the page still knows it.
     *
     * Carried so a RESUMED turn can be re-labelled: a retry rebuilds the composer's chips from
     * what the turn held, and a chip with no name would be persisted back as the media type.
     */
    readonly name?: string;
    /** The bytes, for the turn being sent now. */
    readonly dataUrl?: string;
    /** A presigned https URL, for a turn being replayed. */
    readonly url?: string;
}

/**
 * A user turn's content once media is attached.
 *
 * Three shapes, because the dialects disagree and a wrong shape is a 400 rather than a fallback:
 * Claude takes `{type:'image'|'document', source:{type:'base64'}}` for bytes and
 * `source:{type:'url'}` for a link, everyone else takes an `image_url` whose url may be either.
 * Media comes BEFORE the text in both, which is Anthropic's own guidance for images and for PDFs
 * ("Place PDFs before text in your requests") and costs nothing to follow.
 *
 * A PDF is DROPPED for every provider but Claude. No other vendor has a part that means "document",
 * and sending one as `image_url` would be a request that half-works -- the refusal the attach step
 * already gives the user is the honest half of this rule.
 *
 * Takes the resolved carriers rather than the attachments: this is pure, and minting a link is not.
 * @param {'claude'|'openai'} provider The wire dialect.
 * @param {string} text The user's question.
 * @param {readonly RequestMedia[]} media The attachments, in the order they were added.
 * @return {unknown} A string when there is no usable media, otherwise the content parts.
 */
export function filesInContent(
    provider: 'claude' | 'openai',
    text: string,
    media: readonly RequestMedia[],
): unknown {
    const carrier = (one: RequestMedia): string => one.dataUrl ?? one.url ?? '';

    // Media with neither carrier is DROPPED rather than sent as an empty block: both dialects
    // reject a part that names no source, and a turn whose object has expired must lose its
    // picture, not its answer. Same rule for a document on a vendor that cannot read one.
    const usable = media.filter(one =>
        carrier(one) !== '' && (provider === 'claude' || one.mime !== PDF_TYPE));

    if (!usable.length) {
        return text;
    }

    const parts = usable.map(one => {
        const source = carrier(one);
        // The ONLY difference between the two blocks is the type name, which is why this is one
        // branch rather than two builders.
        const kind = one.mime === PDF_TYPE ? 'document' : 'image';

        if (provider !== 'claude') {
            return { type: 'image_url', image_url: { url: source } };
        }

        // The `data:` prefix is part of the URL, not of this field: Claude wants the bare base64
        // and the media type beside it. A replayed attachment is a link instead, and Anthropic
        // fetches it -- which is the only form a PDF has once the page has been reloaded.
        return source.startsWith('data:')
            ? {
                type: kind,
                source: {
                    type: 'base64',
                    media_type: one.mime,
                    data: source.slice(source.indexOf(',') + 1),
                },
            }
            : { type: kind, source: { type: 'url', url: source } };
    });

    return [...parts, { type: 'text', text }];
}

/**
 * The prompt the model receives once the attachments are folded in.
 *
 * Tag-delimited rather than fenced: a file that contains ``` would close a fence and turn the
 * rest of the prompt into prose. The tag also gives the model a name to cite.
 * @param {string} prompt What the user typed.
 * @param {readonly ChatAttachment[]} files The attached files, in the order they were added.
 * @return {string} The text to send as the user turn.
 */
export function attachmentPrompt(
    prompt: string,
    files: readonly ChatAttachment[],
): string {
    // Text only: an image travels as message content, not as a prompt tag, so a file with no body
    // contributes nothing here rather than an empty tag the model would read as an empty file.
    const bodies = files.filter(file => file.text);

    if (!bodies.length) {
        return prompt;
    }

    const body = bodies
        .map(file => `<file name="${file.name}">\n${file.text}\n</file>`)
        .join('\n\n');

    return `${body}\n\n${prompt}`;
}

/**
 * A file as a `data:` URL.
 *
 * The browser does the encoding: `readAsDataURL` is the platform's own base64 and it also names the
 * media type, so there is no second implementation here to disagree with the one in the storage
 * service.
 * @param {File} file The picked file.
 * @return {Promise<string>} The data URL.
 */
const readDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });

/**
 * AI chat. Streams against `AiAPIService`, which already accepts a message array and
 * reports deltas — no new service, no new dependency.
 */
@Component({
    selector: 'app-chatai',
    imports: [DatePipe, FormsModule, MatIcon, MatProgressSpinner, MarkdownModule, NgTemplateOutlet, RippleDirective, TranslateModule],
    templateUrl: './chatai.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {
        class: 'grow flex flex-col min-h-0',
        '(document:click)': 'onDocumentClick($event)',
        '(document:keydown.escape)': 'onEscape()',
    },
})
export class ChataiComponent {
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

    /**
     * The vendor whose models the picker is showing.
     *
     * Empty means "follow the selected model", which is what makes the menu open on the right tab
     * without an effect: a tapped tab overrides it, and the model stays the source of truth until
     * somebody taps one.
     */
    protected readonly vendorChoice = signal('');

    /** The strip's selected tab, resolved against what the catalogue actually returned. */
    protected readonly vendorTab = computed(() =>
        pickerTab(this.vendorTabs(), this.vendorChoice(), this.modelAI.value.code));

    /**
     * Every vendor the catalogue returned, in catalogue order and without duplicates.
     *
     * Derived from the LIST rather than a vendor enum: the catalogue is the caller's own keys, so a
     * vendor with no key is not a tab, and one added tomorrow appears with no edit here.
     */
    protected readonly vendorTabs = computed(() => {
        const codes: string[] = [];

        for (const model of this.models()) {
            if (!codes.includes(model.code)) {
                codes.push(model.code);
            }
        }

        return codes;
    });

    /** What the list under the strip shows: one vendor's models. */
    protected readonly vendorModels = computed(() =>
        this.models().filter(model => model.code === this.vendorTab()));

    /**
     * Use a model, and hold the strip on the vendor it came from.
     * @param {AIModel} model The model the user picked.
     * @return {void}
     */
    chooseModel(model: AIModel): void {
        this.vendorChoice.set(model.code);
        this.modelAI.setValue(model);
    }

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
    private readonly crawl = inject(CrawlAPIService);
    private readonly crawlStore = inject(CrawlStoreService);
    private readonly auth = inject(AuthService);
    /** The caller, for the operation row a chat-started job leaves behind. */
    private readonly user = toSignal(this.auth.user$, { initialValue: null });
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
    /** Where the back control goes: the platform's own history, not a route this page picks. */
    private readonly location = inject(Location);
    /**
     * The way out to the dashboard, which `back()` cannot guarantee.
     *
     * This route hides the platform sidebar, so without this the ONLY exit is browser history --
     * and a user who arrived from a bookmark or a shared link has no history to go back through.
     */
    private readonly router = inject(Router);
    /** Which org to return to: the dashboard is the org root, not a bare `/dashboard`. */
    private readonly authz = inject(AuthzService);
    /** The message box itself, so a sent question can collapse back to one row. */
    private readonly draftBox = viewChild<ElementRef<HTMLTextAreaElement>>('draftBox');
    /**
     * The rail's visibility, shared with the shell's header button.
     *
     * The SAME signal the layout writes, not a copy: on this route the platform sidebar is not
     * rendered, so the header's menu button has nowhere else to point.
     */
    private readonly chatRail = inject(ChatRailService);

    readonly messages = signal<ChatMessage[]>([]);
    readonly draft = signal('');
    readonly streaming = signal(false);

    /**
     * Whether the transcript is showing its newest line.
     *
     * State rather than a DOM read inside the follow effect. It is what stops a streaming reply
     * from dragging the viewport back down while the user reads an earlier answer, and it makes
     * that behaviour a value a spec can assert instead of a side effect nobody can observe.
     */
    readonly atBottom = signal(true);

    /**
     * The conversations kept on this device, newest first.
     *
     * Local rather than server-side by decision (`26-chat-frontend-upgrade.md` §4): a second copy in
     * Firestore is a new deletion obligation under `25`, and nothing has decided that yet.
     */
    readonly history = signal<readonly ChatSession[]>([]);

    /** Which conversation is open. Empty is a fresh one that has not been stored yet. */
    readonly activeId = signal('');

    /** Which answer's copy just succeeded, so that button alone can confirm it. */
    readonly copiedId = signal('');

    /** The conversation whose title is being edited, or ''. */
    readonly renamingId = signal('');

    /** The title being typed. Seeded from the stored one so a small fix is easy. */
    readonly renameDraft = signal('');

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
     * Tool rounds spent on this turn, and the ceiling for one answer.
     *
     * A round is one MODEL CALL and can carry many tool calls, so this bounds
     * latency and spend rather than how much work a plan may do. Twelve fits
     * "search a few times, read ten pages, write the files" with room to correct
     * one mistake, and stops a model that has begun asking the same question.
     * Without it the loop in `runBatch` had no end a customer would survive.
     *
     * A SIGNAL rather than a field so the running chip can show the budget being spent. A ceiling
     * nobody can see is a limit that reads as a bug the first time it fires.
     */
    protected readonly rounds = signal(0);
    protected readonly maxRounds = ChataiComponent.MAX_TOOL_ROUNDS;
    private static readonly MAX_TOOL_ROUNDS = 12;

    /** True when the loop stopped short, so the transcript can say why. */
    readonly stoppedAtLimit = signal(false);

    /**
     * True when a tool route failed outright.
     *
     * The MODEL already gets the failure as tool text and may well recover, so this
     * is not an error dialog -- it is the only way the human learns that an answer
     * was built from a partial picture. Without it a dead route is invisible until
     * the answer is wrong.
     */
    readonly toolFailed = signal(false);

    /**
     * The one line the user sees, or '' when there is nothing to say.
     *
     * One key rather than a block per condition: the two reasons are mutually
     * exclusive in practice, and two amber lines stacked would read as two problems.
     * @return {string} A CHAT translation key, or ''.
     */
    protected noticeKey(): string {
        if (this.stoppedAtLimit()) {
            return 'CHAT.TOOL_LIMIT';
        }

        return this.toolFailed() ? 'CHAT.TOOL_FAILED' : '';
    }

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
     * The system prompt this turn sends.
     *
     * The JSON instruction rides on the END of it rather than opening a second system turn, because
     * both vendors need the word "json" somewhere in the prompt for `response_format` to be honoured
     * at all -- sending the field alone is what turns a shape request into an error.
     * @return {string} The prompt for this turn.
     */
    private systemText(): string {
        return this.jsonOn() ? `${this.system} ${JSON_NOTE}` : this.system;
    }

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

    /**
     * The tools this caller may use, as the panel lists them.
     *
     * The SAME array `stream()` offers the model, refreshed on the same tier answer, so the panel
     * cannot claim a capability the request withholds or hide one the caller has. It is also the
     * list `17-mcp-capability-surface.md` phase 1 must serve over `tools/list`.
     */
    protected readonly offered = signal<readonly AiToolSpec[]>(availableTools());

    /**
     * What this turn is allowed to do.
     *
     * `agent` because that is what the page did before the control existed: a default that took
     * capability away would silently change every existing conversation, and a mode is only
     * trustworthy if choosing one is the only way to narrow it.
     */
    readonly mode = signal<ChatMode>('agent');

    /** How much reasoning to ask for. `default` sends no field at all, which is the old request. */
    readonly effort = signal<ThinkEffort>('default');

    /**
     * Whether the answer must be a JSON object.
     *
     * A preference, not a promise: it constrains the SHAPE of the reply and says nothing about its
     * content, and it is honoured only where the vendor takes `response_format`.
     */
    readonly json = signal(false);

    /** The vendor the picked model will be sent to, resolved exactly the way `buildRequest` does. */
    protected readonly requestVendor = computed<AiVendorId>(() =>
        providerFor(this.modelAI.value.code) === 'claude'
            ? 'anthropic'
            : vendorForModelCode(this.modelAI.value.code) ?? 'openai');

    /**
     * Whether the picked model can honour a JSON request, which is what decides whether the switch
     * is drawn at all. The WIRE is guarded again in `formatParams`, because the model can be
     * changed after the switch was already turned on.
     */
    protected readonly jsonOffer = computed(() => JSON_VENDORS.includes(this.requestVendor()));

    /** The turn that is actually asking for JSON: the user wanted it AND this model can. */
    protected readonly jsonOn = computed(() => this.json() && this.jsonOffer());

    /**
     * Tools the user unchecked, by name.
     *
     * A set of what is OFF rather than what is ON, so a tool added to `AI_TOOLS` tomorrow is
     * available without this list knowing about it. The other way round, every new tool would be
     * silently withheld until someone edited a default.
     */
    private readonly offTools = signal<ReadonlySet<string>>(new Set<string>());

    /** Files folded into the next message. Emptied by the send that consumes them. */
    readonly attachments = signal<readonly ChatAttachment[]>([]);

    /**
     * Why the last pick attached nothing, as a translate key, or ''.
     *
     * `onFiles` used to skip a binary silently, so "I dropped a PNG and nothing happened" was the
     * only feedback the user got. One line says what the picker can and cannot read.
     */
    readonly attachError = signal('');

    /**
     * True while a file is being dragged over the composer.
     *
     * A drop that lands anywhere else is the browser's own navigation -- it replaces the app with
     * the file -- so the composer has to say, before the drop, that it is the target. State rather
     * than a CSS `:hover`, because `dragleave` fires when a child is entered and the highlight has
     * to survive that.
     */
    readonly dragging = signal(false);

    /**
     * The images each turn was sent with, by message id.
     *
     * The BYTES, for turns sent in this page, because they are already in memory and replaying
     * them costs no round trip. A turn restored from storage is NOT in here: it holds a key, and
     * `replayImages` mints a link for it at request time, because a link is a five-minute
     * credential and storing one would store a secret that expires.
     */
    private readonly turnMedia = new Map<string, readonly RequestMedia[]>();

    /**
     * Turns whose filed image could not be turned into a link.
     *
     * A chip rather than an error. The platform keeps objects for a retention window and a
     * customer's own bucket may be emptied sooner, so a picture really can be gone. The transcript
     * then says so instead of asking the model about an image it cannot see -- and the request
     * still goes, which is the important half.
     */
    readonly expiredMedia = signal<ReadonlySet<string>>(new Set<string>());

    /** Whether the conversation rail is showing. Open by default: it is the page's only index. */
    readonly railOpen = this.chatRail.open;

    /** How many conversations the rail has rendered. Grows as it is scrolled toward the end. */
    private readonly railShown = signal(RAIL_PAGE);

    /**
     * The conversations the rail draws, ungrouped.
     *
     * Kept for the one question the GROUPS cannot answer: whether everything is rendered yet. Two
     * lists cannot be compared against the total; this slice can. Growing on scroll is the "load
     * more" the menu used to need a button for.
     */
    readonly railSessions = computed(() => this.history().slice(0, this.railShown()));

    /**
     * What the rail's search box holds.
     *
     * Rail-local and never stored: a filter is a way of LOOKING at the list, not a property of a
     * conversation, so it does not belong in localStorage and must not survive a reload.
     */
    readonly query = signal('');

    /** The conversations the search keeps. Every one of them while the box is empty. */
    private readonly matched = computed(() => {
        const needle = this.query();
        return this.history().filter(session => sessionMatches(session, needle));
    });

    /** Whether a search is narrowing the list, which is what the empty state has to say. */
    protected readonly searching = computed(() => this.query().trim().length > 0);

    /** Pinned conversations, newest first. Drawn under their own heading, above the rest. */
    readonly pinnedSessions = computed(() =>
        this.matched().filter(session => session.pinned === true));

    /**
     * Everything else, windowed.
     *
     * The window is shared rather than per-group: `railShown` is one counter, so scrolling grows
     * BOTH lists by one page and the rail can never show more rows than it has ever rendered.
     */
    readonly recentSessions = computed(() => this.matched()
        .filter(session => session.pinned !== true)
        .slice(0, this.railShown()));

    /**
     * The open conversation's title.
     *
     * Empty for a conversation that has not been stored yet, which is what hides the header line:
     * a fresh chat has no name to show, and inventing one would name it before the user's question
     * does.
     */
    protected readonly activeTitle = computed(() =>
        this.history().find(session => session.id === this.activeId())?.title ?? '');

    /**
     * The tools this turn may offer the model.
     *
     * The mode narrows the tier's list and the user's own unchecked names narrow it again, in that
     * order: a mode may not widen what the tier allows, which is why `toolsForMode` filters rather
     * than builds. `stream()` offers exactly this array, so the panel cannot claim a capability the
     * request withholds.
     */
    protected readonly sessionTools = computed(() =>
        toolsForMode(this.offered(), this.mode())
            .filter(tool => !this.offTools().has(tool.name)),
    );

    /** The hidden file input the plus menu opens. */
    private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

    /** This component's own element, so menu-closing stays scoped to the composer. */
    private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

    constructor() {
        this.aiModels.load();

        // A desktop opens on the index, a phone on the conversation: below `lg` the rail is an
        // overlay, so showing it first would cover the thing the user came for. Read ONCE -- this
        // is a default, not a preference, and re-reading it on resize would reopen a rail the user
        // had just closed. `window` is absent during prerender, where the open default is harmless.
        if (typeof window !== 'undefined') {
            this.railOpen.set(window.innerWidth >= 1024);
        }

        // Named for the account rather than `billing`, which this class already uses for the
        // spend cap. Same source as every other tier decision on the client.
        this.billingAccount
            .getAccessMode$()
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(mode => {
                this.paid = isPaidPlan(mode);
                this.offered.set(availableTools(this.paid));
            });

        // A reload keeps the conversation, and the list of them. Restored BEFORE the effects below,
        // so a stored turn is painted by the same pass that would have painted a fresh one -- and it
        // cannot resurrect a reply, because `streaming` starts false either way.
        const restored = this.restoreSessions();
        this.history.set(restored.sessions);
        this.activeId.set(restored.activeId);
        this.messages.set([...restored.messages]);

        // Repairs the selection every time the list moves. Not cosmetic: the list is filled in two
        // passes, and a selection that is not among its options leaves the dropdown blank.
        effect(() => {
            this.models();
            this.modelAI.setValue(this.aiModels.selectionFor(this.modelAI.value), { emitEvent: false });
        });

        // Keeps the newest token in view while a reply streams. `scroller()` is undefined
        // Keeps the newest token in view while a reply streams -- but only while the user is
        // already at the bottom. `scroller()` is undefined during SSR, so this stays
        // browser-only without touching `document`.
        effect(() => {
            this.messages();
            const element = this.scroller()?.nativeElement;
            if (!element) {
                return;
            }

            // An empty transcript has nowhere to scroll, and leaving the flag false would keep the
            // next answer from following after "New chat" left the list empty.
            if (!this.messages().length) {
                this.atBottom.set(true);
                return;
            }

            if (this.atBottom()) {
                element.scrollTop = element.scrollHeight;
            }
        });
    }

    /**
     * Track whether the transcript is showing its newest line.
     *
     * Read here, on the real scroll event, rather than inside the follow effect. The effect fires
     * on every streamed delta, so asking the element each time made the scroll unconditional and
     * pulled the user back down while they were reading an earlier answer.
     * @param {Event} event The scroller's scroll event.
     */
    onScroll(event: Event): void {
        const element = event.target as HTMLElement | null;
        if (element) {
            this.atBottom.set(isAtBottom(element));
        }
    }

    /**
     * Return to the newest message, and resume following it.
     *
     * Sets the flag as well as the position: moving the viewport alone would leave the effect
     * declining to follow the next token, and the pill would never go away.
     */
    jumpToLatest(): void {
        const element = this.scroller()?.nativeElement;
        this.atBottom.set(true);
        if (element) {
            element.scrollTop = element.scrollHeight;
        }
    }

    toggleRail(): void {
        this.chatRail.toggle();
    }

    /**
     * Leave the chat, back the way the user came.
     *
     * The browser's own history rather than a hard-coded destination: this rail is the route's only
     * menu, so the one control that leaves it must return to whatever page sent the user here --
     * which a fixed link cannot know. Going back past the chat to a page outside the app is the
     * browser's decision and is left to it.
     * @return {void}
     */
    back(): void {
        this.location.back();
    }

    /**
     * Leave the chat for the app home, whatever sent the user here.
     *
     * `orgScopedUrl` rather than a literal `/dashboard`: the org root IS the dashboard, and a bare
     * `/dashboard` is read by the `:orgId` route as an org literally named "dashboard". With no
     * active org the helper returns the bare url, which the legacy tree still resolves.
     * @return {void}
     */
    home(): void {
        void this.router.navigateByUrl(orgScopedUrl('/dashboard', this.authz.activeOrgId));
    }

    /**
     * Render the next page of conversations once the rail is scrolled to its end.
     *
     * Not a fetch: every conversation is already in memory, and calling this "loading" would be a
     * lie told by a spinner. What it saves is DOM, and the button it replaces.
     * @param {Event} event The rail's scroll event.
     * @return {void}
     */
    onRailScroll(event: Event): void {
        const element = event.target as HTMLElement | null;

        if (!element || this.railShown() >= this.history().length) {
            return;
        }

        if (element.scrollTop + element.clientHeight < element.scrollHeight - RAIL_TOLERANCE_PX) {
            return;
        }

        this.railShown.update(shown => shown + RAIL_PAGE);
    }

    pickFiles(): void {
        this.fileInput()?.nativeElement.click();
    }

    /**
     * Read the picked files and attach them.
     *
     * Three routes, because three kinds of file exist and only one of them a chat turn cannot
     * carry: an image or a PDF is filed as BYTES and travels as message content, everything else
     * is read as text and folded into the prompt. The input's value is cleared so picking the same
     * file twice still fires `change`.
     * @param {Event} event The input's change event.
     * @return {Promise<void>} Resolves once every file has been read.
     */
    async onFiles(event: Event): Promise<void> {
        const input = event.target as HTMLInputElement | null;
        const picked = Array.from(input?.files ?? []);

        if (input) {
            input.value = '';
        }

        await this.ingest(picked);
    }

    /**
     * Read a set of files into attachment chips.
     *
     * Shared by the picker, a drop and a paste: the three are the same file arriving by a different
     * route, and only the picker has a value that has to be cleared for the next `change`.
     * @param {File[]} picked The files to read.
     * @return {Promise<void>} Resolves once every file has been read.
     */
    private async ingest(picked: File[]): Promise<void> {
        const room = Math.max(ATTACH_MAX_FILES - this.attachments().length, 0);
        const added: ChatAttachment[] = [];
        let refused = room < picked.length;

        this.attachError.set('');

        for (const file of picked.slice(0, room)) {
            const pdf = file.type === PDF_TYPE;

            // Only Claude reads a document, and no other vendor has a part that means one. Refused
            // HERE rather than dropped when the request is built, because a chip that disappears
            // from the user's own turn is the silent failure this method exists to stop.
            if (pdf && providerFor(this.modelAI.value.code) !== 'claude') {
                refused = true;
                continue;
            }

            if (pdf || file.type.startsWith('image/')) {
                const one = await this.mediaAttachment(file);

                if (!one) {
                    refused = true;
                    continue;
                }

                added.push(one);
                continue;
            }

            let body = '';

            try {
                body = await file.text();
            } catch {
                // Unreadable (a directory, a locked file) is reported rather than swallowed: a
                // file that produces no chip and no message reads as a broken picker.
                refused = true;
                continue;
            }

            // A binary file decodes to replacement characters, and twelve thousand of them is a
            // prompt that costs money and says nothing. Refused, and SAID SO -- this used to
            // `continue` silently, so dropping an image looked like nothing happening at all.
            if ((body.slice(0, 2000).match(/\uFFFD/g)?.length ?? 0) > 100) {
                refused = true;
                continue;
            }

            added.push({
                // The name reaches a prompt tag, so the characters that could close it are dropped.
                name: file.name.replace(/["<>\r\n]/g, '').slice(0, 80) || 'file',
                text: body.slice(0, ATTACH_MAX_CHARS),
                truncated: body.length > ATTACH_MAX_CHARS,
            });
        }

        if (added.length) {
            this.attachments.update(list => [...list, ...added]);
        }

        if (refused) {
            this.attachError.set('CHAT.ATTACH_UNSUPPORTED');
        }
    }

    /**
     * Claim a drag that is carrying files, so the browser does not navigate to it.
     *
     * The default action of a drop on a page is to open the file, which would replace the whole
     * app with a PNG; cancelling it here is what makes the composer a drop target at all. Only a
     * file drag is claimed -- dragging selected text into the box still has to paste as text.
     * @param {DragEvent} event The drag event over the composer.
     * @return {void}
     */
    onDragOver(event: DragEvent): void {
        if (!event.dataTransfer?.types.includes('Files')) {
            return;
        }

        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        this.dragging.set(true);
    }

    /**
     * Drop the highlight when the pointer leaves the composer.
     *
     * Fires on every child too, and a child is most of the composer's area, so the flag is cleared
     * without inspecting `relatedTarget`: a stale highlight that lies about being a target is worse
     * than one that flickers while the pointer crosses the textarea.
     * @return {void}
     */
    onDragLeave(): void {
        this.dragging.set(false);
    }

    /**
     * Take the files that were dropped on the composer.
     *
     * The highlight is cleared FIRST: `ingest` awaits a read per file, and a box that keeps its
     * ring while the chips appear reads as still waiting for a drop.
     * @param {DragEvent} event The drop event.
     * @return {void}
     */
    onDrop(event: DragEvent): void {
        event.preventDefault();
        this.dragging.set(false);
        void this.ingest(Array.from(event.dataTransfer?.files ?? []));
    }

    /**
     * Take a file pasted into the composer -- a screenshot, usually.
     *
     * Only files are claimed. A paste that carries text AND a file is left to the browser, because
     * `preventDefault` here would delete the text the user was about to send.
     * @param {ClipboardEvent} event The paste event.
     * @return {void}
     */
    onPaste(event: ClipboardEvent): void {
        const files = Array.from(event.clipboardData?.files ?? []);

        if (!files.length) {
            return;
        }

        event.preventDefault();
        void this.ingest(files);
    }

    /**
     * Read and file one attachment -- an image or a PDF -- or null when it cannot be sent.
     *
     * The `data:` URL is what the request carries, not a presigned link: a link is minted for five
     * minutes, and a tool loop can outlive that, which would fail the vendor's fetch mid-turn
     * instead of at the boundary. The bytes are ALSO filed, so the object survives this tab and can
     * back a stored conversation later -- a failed upload does not block the send, because the
     * answer is what the user asked for.
     * @param {File} file The picked image or PDF.
     * @return {Promise<ChatAttachment | null>} The attachment, or null when it is too big or not a
     * type a vendor we address can read.
     */
    private async mediaAttachment(file: File): Promise<ChatAttachment | null> {
        const readable = IMAGE_TYPES.includes(file.type) || file.type === PDF_TYPE;

        if (!readable || file.size > MEDIA_MAX_BYTES) {
            return null;
        }

        const bytes = new Uint8Array(await file.arrayBuffer());
        const name = file.name.replace(/["<>\r\n]/g, '').slice(0, 80) || 'file';
        const dataUrl = await readDataUrl(file);

        const key = await firstValueFrom(this.storage.saveBytes(bytes, name, file.type))
            .then(reply => reply.key)
            .catch(() => '');

        return {
            name,
            text: '',
            truncated: false,
            mime: file.type,
            key,
            dataUrl,
        };
    }

    removeAttachment(index: number): void {
        this.attachments.update(list => list.filter((_, at) => at !== index));
    }

    /** Whether a tool is still offered. An unchecked name is refused by `sessionTools`. */
    isToolOn(name: string): boolean {
        return !this.offTools().has(name);
    }

    toggleTool(name: string, on: boolean): void {
        this.offTools.update(current => {
            const next = new Set(current);

            if (on) {
                next.delete(name);
            } else {
                next.add(name);
            }

            return next;
        });
    }

    /** The modes the composer offers, narrowest first. */
    protected readonly modes: readonly ChatMode[] = ['ask', 'plan', 'agent'];

    /** The effort values the composer offers, weakest first. */
    protected readonly efforts: readonly ThinkEffort[] = ['default', 'off', 'low', 'medium', 'high'];

    /** A mode's icon. Material ligature names, the same set the rest of the app draws from. */
    protected modeIcon(mode: ChatMode = this.mode()): string {
        if (mode === 'ask') {
            return 'chat_bubble_outline';
        }

        return mode === 'plan' ? 'account_tree' : 'smart_toy';
    }

    protected modeKey(mode: ChatMode = this.mode()): string {
        return `CHAT.MODE_${mode.toUpperCase()}`;
    }

    protected modeHint(mode: ChatMode = this.mode()): string {
        return `CHAT.MODE_${mode.toUpperCase()}_HINT`;
    }

    protected effortKey(effort: ThinkEffort = this.effort()): string {
        return `CHAT.EFFORT_${effort.toUpperCase()}`;
    }

    /**
     * Close the `<details>` a menu item lives in.
     *
     * `<details>` stays open after an item inside it is clicked, which would leave the menu
     * covering the composer it was opened from. Walking up to the nearest one is the version that
     * needs no template ref per menu.
     * @param {Event} event The click, from which the enclosing menu is found.
     * @return {void}
     */
    closeMenu(event: Event): void {
        let node = event.target as HTMLElement | null;

        while (node) {
            if (node instanceof HTMLDetailsElement) {
                node.open = false;
                return;
            }

            node = node.parentElement;
        }
    }

    /**
     * Close any composer menu the click landed outside of.
     *
     * `<details>` keeps no open set, so without this a second menu opens ON TOP of the first and
     * both stay up. Scoped to this component's own `details[data-menu]` and not the document: a
     * `<details>` anywhere else on the page keeps its native behaviour.
     * @param {Event} event The click, whose target decides which menus survive.
     * @return {void}
     */
    onDocumentClick(event: Event): void {
        const target = event.target as Node | null;

        for (const menu of this.menus()) {
            if (target && !menu.contains(target)) {
                menu.open = false;
            }
        }
    }

    /** Escape closes every composer menu, which is what every menu on the platform does. */
    onEscape(): void {
        for (const menu of this.menus()) {
            menu.open = false;
        }
    }

    private menus(): HTMLDetailsElement[] {
        return Array.from(
            this.host.nativeElement.querySelectorAll<HTMLDetailsElement>('details[data-menu]'),
        );
    }

    /**
     * Copy one answer in full.
     *
     * The `clipboard` directive on `<markdown>` only adds a button to CODE BLOCKS, so there was no
     * way to copy a whole reply. Guarded the way `webrtc.service` guards the same call: `navigator`
     * is absent during SSR and `clipboard` is absent outside a secure context, and a button must
     * degrade to nothing rather than throw.
     * @param {string} id The turn, so only the button that was pressed shows the confirmation.
     * @param {string} content The answer as rendered.
     * @return {Promise<void>} Resolves once the write settles.
     */
    async copyAnswer(id: string, content: string): Promise<void> {
        if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
            return;
        }

        try {
            await navigator.clipboard.writeText(content);
        } catch {
            // A refused clipboard needs a permission only the user can grant; nothing to report.
            return;
        }

        this.copiedId.set(id);
        setTimeout(() => this.copiedId.set(''), 800);
    }

    send(): void {
        const prompt = this.draft().trim();

        // An attachment with nothing typed is still a message: "what is in this file?" is the
        // obvious question, and refusing it would leave an enabled Send button that did nothing.
        if ((!prompt && !this.attachments().length) || this.streaming()) {
            return;
        }

        this.draft.set('');
        // Clearing the value does not clear the HEIGHT: the box was measured against the text that
        // has just been sent, so it would sit tall and empty until the next keystroke.
        this.draftBox()?.nativeElement.style.removeProperty('height');
        this.submit(prompt);
    }

    /**
     * Grow the message box with what is typed, up to the CSS cap.
     *
     * `rows="1"` and a `max-h` on their own do nothing: a textarea keeps one row and scrolls its
     * content, so a long question was hidden inside a one-line box. The height is cleared before it
     * is measured, because `scrollHeight` reports the content only once the previous height is not
     * clamping it. `max-h-64` still wins over the inline height, so nothing here needs to clamp.
     * @param {Event} event The textarea's input event.
     * @return {void}
     */
    resizeDraft(event: Event): void {
        const field = event.target as HTMLTextAreaElement | null;

        if (!field) {
            return;
        }

        this.grow(field);
    }

    /**
     * Size a textarea to its content.
     *
     * Cleared first because `scrollHeight` reports the content only once the previous height is not
     * clamping it. Two callers -- typing, and an edited turn landing in the box -- and one rule.
     * @param {HTMLTextAreaElement} field The box to measure.
     * @return {void}
     */
    private grow(field: HTMLTextAreaElement): void {
        field.style.height = 'auto';
        field.style.height = `${field.scrollHeight}px`;
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
     * from the last user turn onward and submit it again -- WITH the attachments that turn
     * carried, which is the difference between regenerating an answer and asking a question the
     * model cannot see the picture for. The button is labelled by whichever state the user is in.
     */
    retry(): void {
        if (this.streaming()) {
            return;
        }

        const found = this.lastUserTurn();

        if (!found) {
            return;
        }

        this.messages.set(this.messages().slice(0, found.index));
        // The turn's OWN attachments, put back where `submit` reads them from. Without this a
        // regenerated image or PDF turn was resent as text and the model was asked about a picture
        // it could no longer see -- the defect this method used to carry a comment about.
        this.attachments.set(this.chipsFor(found.turn));
        this.submit(found.turn.content);
    }

    /**
     * The last thing the user asked, and where it sits.
     *
     * One definition for the two actions that act on it -- regenerate and edit -- so the two can
     * never disagree about which turn they mean. A loop rather than `findLastIndex`/`at`, which need
     * a newer `lib` than this project pins; the transcript is short and this runs once per click.
     * @return {{index: number, turn: ChatMessage} | null} The turn, or null when there is none.
     */
    private lastUserTurn(): { index: number; turn: ChatMessage } | null {
        const list = this.messages();

        for (let index = list.length - 1; index >= 0; index--) {
            if (list[index].role === 'user') {
                return { index, turn: list[index] };
            }
        }

        return null;
    }

    /**
     * Put the last question back in the box, with its attachments, and drop the answer.
     *
     * Edits rather than resends: the turn is REMOVED and its text and media are handed to the
     * composer, so one wrong word costs one word instead of a retyped question and a re-attached
     * file. `retry` is the same operation that skips the editing step.
     * @return {void}
     */
    editTurn(): void {
        if (this.streaming()) {
            return;
        }

        const found = this.lastUserTurn();

        if (!found) {
            return;
        }

        this.draft.set(found.turn.content);
        this.attachments.set(this.chipsFor(found.turn));
        this.messages.set(this.messages().slice(0, found.index));
        this.failure.set(null);
        this.persistTranscript();

        // Deferred: the binding writes the value on the next change-detection pass, and measuring
        // before it lands would size the box against the text it is replacing.
        setTimeout(() => {
            const box = this.draftBox()?.nativeElement;

            if (box) {
                box.focus();
                this.grow(box);
            }
        });
    }

    /**
     * The composer chips that reproduce what one turn carried.
     *
     * Bytes first, because a turn sent in THIS page still holds them and replaying costs no round
     * trip; a turn restored from storage holds only storage keys, and `replayMedia` mints a link for
     * those at request time. The in-memory entry is dropped afterwards, since the turn it belonged
     * to is about to be replaced by a new id.
     * @param {ChatMessage} turn The user turn being resent.
     * @return {ChatAttachment[]} Chips ready for `submit`.
     */
    private chipsFor(turn: ChatMessage): ChatAttachment[] {
        const bytes = this.turnMedia.get(turn.id) ?? [];

        if (bytes.length) {
            this.turnMedia.delete(turn.id);
            return bytes.map(one => ({
                name: one.name ?? one.mime,
                text: '',
                truncated: false,
                mime: one.mime,
                dataUrl: one.dataUrl,
            }));
        }

        return (turn.media ?? []).map(one => ({
            name: one.name,
            text: '',
            truncated: false,
            mime: one.mime,
            key: one.key,
        }));
    }

    /**
     * Keep the open conversation, and the list of them, where a reload can find them.
     *
     * Called at the two TURN BOUNDARIES -- when the question is asked and when the answer ends --
     * and never per streamed delta, which would re-serialise every conversation on every token.
     * A store that refuses (full, disabled, private mode) is swallowed: losing the cache is not
     * worth failing a reply the user already paid for.
     * @return {void}
     */
    private persistTranscript(): void {
        const messages = this.messages().slice(-TRANSCRIPT_MAX);
        const id = this.activeId();

        // An empty conversation is neither written nor listed: a menu row that opens to nothing is
        // worse than no row, and `newChat` leaves the list holding only real history.
        if (!messages.length) {
            const kept = id
                ? this.history().filter(session => session.id !== id)
                : this.history();

            this.history.set(kept);
            this.activeId.set('');
            this.writeSessions('', kept);
            return;
        }

        const session: ChatSession = {
            id: id || newSessionId(),
            title: sessionTitle(messages),
            at: Date.now(),
            messages,
        };

        const sessions = [session, ...this.history().filter(other => other.id !== session.id)]
            .slice(0, SESSIONS_MAX);

        this.activeId.set(session.id);
        this.history.set(sessions);
        this.writeSessions(session.id, sessions);
    }

    /**
     * Write the list, or say nothing.
     *
     * Takes the values rather than reading the signals so the one caller that runs BEFORE they are
     * set (adopting the previous shape) cannot write the old list over the new one.
     * @param {string} activeId The conversation to reopen.
     * @param {readonly ChatSession[]} sessions The conversations.
     * @return {void}
     */
    private writeSessions(activeId: string, sessions: readonly ChatSession[]): void {
        try {
            this.local.setItem(SESSIONS_KEY, JSON.stringify({ activeId, sessions }));
        } catch {
            // Deliberately silent: a full or disabled store cannot fail for a reason the user could
            // act on, so a line here would be noise in a console nobody reads.
        }
    }

    /**
     * The stored conversations, the open one, and its turns.
     *
     * Every failure is an empty set rather than a throw: this runs inside the constructor, where an
     * exception would leave the page unable to render at all.
     * @return {*} The list, the active id, and the turns to open with.
     */
    private restoreSessions(): {
        sessions: readonly ChatSession[];
        activeId: string;
        messages: readonly ChatMessage[];
    } {
        const empty = {
            sessions: [] as readonly ChatSession[],
            activeId: '',
            messages: [] as readonly ChatMessage[],
        };
        let raw: string | null = null;

        try {
            raw = this.local.getItem(SESSIONS_KEY);
        } catch {
            return empty;
        }

        if (!raw) {
            return this.adoptLegacyTranscript();
        }

        try {
            const parsed = JSON.parse(raw) as { activeId?: unknown; sessions?: unknown };

            if (!Array.isArray(parsed?.sessions)) {
                return empty;
            }

            const sessions = parsed.sessions
                .map(toChatSession)
                .filter((session): session is ChatSession => session !== null);

            const active = sessions.find(session => session.id === parsed.activeId);

            return { sessions, activeId: active?.id ?? '', messages: active?.messages ?? [] };
        } catch {
            return empty;
        }
    }

    /**
     * The one conversation the previous version stored, adopted as the first session.
     *
     * Written back under the new key immediately, so the next reload takes the ordinary path. The
     * old key is NOT removed: until this has been read back intact once, it is the only copy.
     * @return {*} The adopted list and its turns.
     */
    private adoptLegacyTranscript(): {
        sessions: readonly ChatSession[];
        activeId: string;
        messages: readonly ChatMessage[];
    } {
        const messages = this.readLegacyTranscript();

        if (!messages.length) {
            return { sessions: [], activeId: '', messages: [] };
        }

        const session: ChatSession = {
            id: newSessionId(),
            title: sessionTitle(messages),
            at: Date.now(),
            messages,
        };

        this.writeSessions(session.id, [session]);

        return { sessions: [session], activeId: session.id, messages };
    }

    /**
     * The previous single-transcript value, or nothing.
     *
     * A malformed value is either something an older version wrote or something the user edited,
     * and "start empty" is the honest answer to both.
     * @return {readonly ChatMessage[]} The turns that could be read back.
     */
    private readLegacyTranscript(): readonly ChatMessage[] {
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

            return parsed
                .map(toChatMessage)
                .filter((message): message is ChatMessage => message !== null);
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

        // Persist BEFORE clearing, so the turns already finished join the history rather than being
        // thrown away. Starting a new conversation must not destroy the old one -- that is the whole
        // difference between a session list and the single transcript this replaced.
        this.persistTranscript();

        this.messages.set([]);
        this.failure.set(null);
        this.activeId.set('');
    }

    /**
     * Open a stored conversation.
     *
     * Stops the reply in flight first, for the reason `newChat` does: a stream is bound to the turn
     * it is filling, and swapping the transcript underneath it would append an answer to a
     * conversation the user is no longer reading.
     * @param {string} id The conversation to open.
     * @return {void}
     */
    openSession(id: string): void {
        const session = this.history().find(candidate => candidate.id === id);

        if (!session || session.id === this.activeId()) {
            return;
        }

        this.stop();
        // Set BEFORE the transcript so the follow effect sees it. Opening a conversation must land on
        // its NEWEST turn; without this it inherits whatever `atBottom` the previous conversation
        // left, so a session opened after scrolling up in another one starts at its first message
        // with the jump pill already showing.
        this.atBottom.set(true);
        this.messages.set([...session.messages]);
        this.failure.set(null);
        this.activeId.set(session.id);
    }

    /**
     * Forget a stored conversation.
     *
     * Deleting the OPEN one clears the transcript too, because leaving its turns on screen would
     * offer a conversation no reload can bring back.
     * @param {string} id The conversation to delete.
     * @return {void}
     */
    deleteSession(id: string): void {
        const sessions = this.history().filter(session => session.id !== id);
        const wasOpen = this.activeId() === id;

        this.history.set(sessions);

        if (wasOpen) {
            this.stop();
            this.messages.set([]);
            this.failure.set(null);
            this.activeId.set('');
        }

        this.writeSessions(wasOpen ? '' : this.activeId(), sessions);
    }

    /**
     * Pin a conversation to the rail's pinned group, or unpin it.
     *
     * A stored flag rather than a second list: the two headings are drawn from ONE array, so a
     * conversation the user is looking for is never in the second place they have to think of. The
     * cap is applied where the list is BUILT (`persistTranscript`), so toggling a pin rewrites the
     * same rows and cannot grow it.
     * @param {string} id The conversation.
     * @return {void}
     */
    togglePin(id: string): void {
        const sessions = this.history().map(session =>
            session.id === id ? { ...session, pinned: !session.pinned } : session);

        this.history.set(sessions);
        this.writeSessions(this.activeId(), sessions);
    }

    /**
     * Begin editing a conversation's title.
     *
     * Rename exists because the title is derived from the first question, and the first question is
     * not always the one the conversation ended up being about.
     * @param {ChatSession} session The conversation to rename.
     * @return {void}
     */
    startRename(session: ChatSession): void {
        this.renamingId.set(session.id);
        this.renameDraft.set(session.title);
    }

    cancelRename(): void {
        this.renamingId.set('');
    }

    /**
     * Store a new title.
     *
     * Trimmed and capped like `sessionTitle`, because this value now comes from a field rather than
     * from derived content. An empty title is refused rather than stored -- an unlabelled row is
     * worse than the old name -- and a no-op commit is ignored so the blur that follows Enter does
     * not write the list twice.
     * @param {string} id The conversation.
     * @return {void}
     */
    commitRename(id: string): void {
        if (this.renamingId() !== id) {
            return;
        }

        const title = this.renameDraft().trim().slice(0, TITLE_MAX);
        const history = title
            ? this.history().map(session => (session.id === id ? { ...session, title } : session))
            : this.history();

        if (title) {
            this.history.set(history);
            this.writeSessions(this.activeId(), history);
        }

        this.renamingId.set('');
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
        // The per-turn budget lives HERE, not in `send`. Both `send` and `retry` reach this method,
        // and resetting in `send` alone meant a retry inherited the previous turn's rounds -- so a
        // retry after a turn that spent all twelve returned immediately with `stoppedAtLimit` set
        // and no answer at all. The two amber notices had the same problem: they survived into the
        // next turn. One reset, on the path every turn takes.
        this.rounds.set(0);
        this.stoppedAtLimit.set(false);
        this.toolFailed.set(false);

        // Attachments are folded into the QUESTION rather than kept beside it, so the transcript
        // shows exactly what the model was given and a retry resends it. Consumed here because
        // this is the one path every turn takes -- leaving them attached would post them twice.
        const attachments = this.attachments();
        const question = attachmentPrompt(prompt, attachments);

        if (attachments.length) {
            this.attachments.set([]);
        }

        // Snapshot history BEFORE the empty assistant placeholder is pushed, otherwise the
        // streamed reply would be fed back to the model as its own prior turn. Named `turns`
        // because `history` is already the conversation RAIL, injected above.
        const turns = this.messages();
        const code = this.modelAI.value.code;
        const provider = providerFor(code);
        // The carriers this page still holds, images and PDFs alike: the form a request uses when
        // there is no link to mint first.
        const inMemory = attachments
            .filter(file => file.dataUrl)
            .map(file => ({ mime: file.mime ?? '', name: file.name, dataUrl: file.dataUrl as string }));

        // What a reload can replay: the object key, not the bytes. Filed ON the turn so it
        // survives the page, which is the whole difference between this and `turnMedia`.
        const media: ChatMedia[] = attachments
            .filter(file => file.key && file.mime)
            .map(file => ({ key: file.key as string, mime: file.mime as string, name: file.name }));

        const userId = newId();

        this.messages.update(list => [
            ...list,
            {
                id: userId,
                role: 'user',
                content: question,
                at: Date.now(),
                ...(media.length ? { media } : {}),
            },
            { id: newId(), role: 'assistant', content: '', at: Date.now() },
        ]);

        // Recorded AFTER the turn has an id, so the next turn's resolver finds it. `retry` hands it
        // back to the composer before dropping the turn, which is what lets a regenerated image turn
        // keep its picture.
        if (inMemory.length) {
            this.turnMedia.set(userId, inMemory);
        }
        // The QUESTION is persisted here rather than at the end of the turn, so a reload
        // mid-answer keeps what the user typed. The empty placeholder goes in with it and
        // `toChatMessage` drops it on the way back out.
        this.persistTranscript();
        this.streaming.set(true);
        this.failure.set(null);

        // Minting a link for a restored turn is a round trip, so the question is on screen before
        // it starts and the effect above has already begun following it.
        void this.replayMedia(turns).then(replay => {
            // A stop() while the links were being minted has already closed this turn. Starting
            // the stream now would append an answer to a conversation the user ended -- and to a
            // transcript `newChat` may have emptied.
            if (!this.streaming()) {
                return;
            }

            const request = buildRequest(
                code,
                // The resolver replays what EARLIER turns were sent with. Without it an image
                // reached the vendor once and every follow-up asked about a picture the model
                // could not see.
                buildHistory(turns, question, provider, id => replay.get(id) ?? []),
                this.systemText(),
            );

            if (inMemory.length) {
                const last = request.messages[request.messages.length - 1];
                request.messages[request.messages.length - 1] = {
                    role: last.role,
                    content: filesInContent(request.provider, question, inMemory),
                };
            }

            // The array is the conversation the PROVIDER sees. It is extended in place once a
            // tool round adds turns, so the answering round reads the calls and their results
            // rather than being asked the original question again.
            this.stream(request, request.messages, true);
        });
    }

    /**
     * The images earlier turns were sent with, as a request can carry them.
     *
     * A turn sent in this page still holds its bytes and replays for free. A turn restored from
     * storage holds only the object KEY, and a vendor fetches a link itself -- so the link is
     * minted here, per request, and never stored: a presigned URL lives five minutes
     * (`PRESIGN_TTL_SECONDS`) and is a bearer credential.
     *
     * Capped at one message's worth of parts, newest first. Every ROUND re-sends the conversation
     * and one turn can spend twelve of them, so replaying a whole gallery would multiply the
     * vendor's fetch cost by the tool budget; `IMAGE_MAX_BYTES` is what each of these was already
     * limited to when it was attached, which keeps the replayed set under 4 MiB.
     * @param {readonly ChatMessage[]} turns The conversation about to be sent.
     * @return {Promise<Map<string, readonly RequestMedia[]>>} Images by turn id. Never rejects.
     */
    private async replayMedia(
        turns: readonly ChatMessage[],
    ): Promise<Map<string, readonly RequestMedia[]>> {
        const images = new Map<string, readonly RequestMedia[]>(this.turnMedia);
        const expired = new Set(this.expiredMedia());
        const pending: { id: string; media: ChatMedia }[] = [];

        for (const turn of turns) {
            if (turn.role !== 'user' || !turn.media?.length || images.has(turn.id)) {
                continue;
            }

            for (const media of turn.media) {
                pending.push({ id: turn.id, media });
            }
        }

        // Grouped before resolving, so two images on ONE turn do not race each other into
        // overwriting the turn's entry.
        const groups = new Map<string, ChatMedia[]>();

        for (const { id, media } of pending.slice(-ATTACH_MAX_FILES)) {
            groups.set(id, [...(groups.get(id) ?? []), media]);
        }

        try {
            await Promise.all(
                Array.from(groups).map(async ([id, list]) => {
                    const resolved = await Promise.all(
                        list.map(async (media): Promise<RequestMedia | null> => {
                            const url = await firstValueFrom(this.storage.presign(media.key))
                                .then(reply => reply.url)
                                .catch(() => '');

                            return url ? { mime: media.mime, url } : null;
                        }),
                    );

                    const usable = resolved.filter((one): one is RequestMedia => one !== null);

                    if (usable.length) {
                        images.set(id, usable);
                        expired.delete(id);
                    } else {
                        expired.add(id);
                    }
                }),
            );
        } catch {
            // Nothing here may fail the turn. A link that could not be minted is one image the
            // model is not shown; the answer is what the user asked for.
        }

        this.expiredMedia.set(expired);

        return images;
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
        // The MODE's list rather than the tier's. `availableTools` is what the tier allows; offering
        // that here would hand a Plan turn the write tools the composer just promised to hide.
        const offered = offerTools ? this.sessionTools() : undefined;
        const accumulator = newToolCallAccumulator();

        // The vendor the model was picked from. The guard is for the TYPE rather than the
        // runtime: on this branch it is never Anthropic (that is `claude`), so an undefined
        // vendor here could only mean a code the table does not know -- and `sendToOpenAI`
        // then resolves from the name, as it always did.
        //
        // `jina` needs no clause: it is a scrape provider and is not in `AiVendorId`.
        const vendor = request.vendor === 'anthropic' ? undefined : request.vendor;

        // Computed per round rather than carried on `ChatRequest`: it depends on a vendor whose
        // spelling differs per model, and an empty object leaves the body exactly as it was.
        const extra = {
            ...reasoningParams(request.vendor, this.modelAI.value.name, this.effort()),
            ...formatParams(this.jsonOn(), request.vendor),
        };

        const source = claude
            ? this.ai.sendToClaudeAI(messages, this.modelAI.value.name, this.system, offered, extra)
            : this.ai.sendToOpenAI(messages, this.modelAI.value.name, undefined, offered, vendor, extra);

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

                    // Only the FINAL chunk carries it (`stream_options.include_usage`), so this
                    // fires once per round. Accumulated across rounds because that is what the
                    // turn actually billed: each tool round re-sends the conversation.
                    const spent = tokenUsage(chunk?.usage);
                    if (spent) {
                        this.recordUsage(spent);
                    }
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
        // The budget is checked BEFORE the approval gate, because a parked batch is
        // still a round the caller will pay for once they approve it. Stopping here
        // keeps the promise the transcript makes: the tools above really did run.
        if (this.rounds() >= ChataiComponent.MAX_TOOL_ROUNDS) {
            this.stoppedAtLimit.set(true);
            this.finish();
            return;
        }

        this.rounds.update(spent => spent + 1);

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
    private execute(call: AiToolCall): Observable<ExecutedCall> {
        const resolution = resolveToolCall(call, this.paid);

        if (!resolution.ok) {
            return of({ call, content: refusalText(resolution), status: 'refused' });
        }

        // A SECOND trust boundary, not a UI filter. `sessionTools` decides what the model is
        // OFFERED; a model can still name a tool it was never offered, and without this check that
        // name would reach a route because it asked nicely. Answered as text so the round recovers,
        // and named, so the model can say which mode would allow it.
        if (this.mode() !== 'agent' && resolution.tool.requiresConfirm === true) {
            return of({
                call,
                content:
                    `The tool "${resolution.tool.name}" changes account state, and this ` +
                    `conversation is in ${this.mode()} mode, which may only read. Do not ` +
                    'retry it; tell the user it needs Agent mode.',
                status: 'refused',
            });
        }

        this.toolRunning.set(resolution.tool.name);

        const args = resolution.call.args;
        const route = resolution.tool.name;

        const source = this.dispatch(route, args);

        return source.pipe(
            // A 200 whose body reports an error is still `ok` here: the model received an answer it
            // can act on, and only the transport failing is the human's business.
            map(envelope => ({ call, content: toolResultText(envelope), status: 'ok' as const })),
            catchError((error: unknown) => {
                // The model can retry from the text below; the human cannot see this
                // at all unless the transcript says so.
                this.toolFailed.set(true);

                return of({
                    call,
                    content: `The tool "${route}" failed: ${failureLine(error)}`,
                    status: 'failed' as const,
                });
            }),
        );
    }

    /**
     * Queue scraping work the user can walk away from.
     *
     * Two shapes and one tool, because the difference is a field the model already
     * knows. Without `when` the batch is queued NOW through the same route the
     * Operations page uses; with it, the row is stored as `Scheduled` and the
     * platform's dispatcher starts it at that time. Either way the work becomes a
     * JOB, not a chat request, so it survives this conversation closing — which is
     * the whole point of offering it here.
     *
     * Refusals are returned as data rather than thrown: a model that reads "that
     * has to be an absolute http(s) URL" can correct itself in the same turn,
     * where a thrown error ends the turn with a stack trace.
     *
     * Only page scraping: that is what the job route runs. A model asking for
     * anything else is told what this tool actually does rather than being
     * silently given a scrape it did not request.
     * @param {Record<string, unknown>} args The model's arguments.
     * @return {Promise<unknown>} What to tell the model.
     */
    private async createJob(args: Record<string, unknown>): Promise<unknown> {
        const request = jobRequest(args);

        if (!request.ok) {
            return { error: request.error };
        }

        const uid = this.user()?.uid ?? '';
        if (!uid) {
            return { error: 'There is no signed-in account to queue this under.' };
        }

        const { urls, startsAt } = request;
        const scheduled = startsAt !== null;
        const operation = this.jobRow(uid, urls, startsAt ?? Date.now());

        try {
            if (scheduled) {
                await firstValueFrom(this.crawlStore.storeCrawlOperation(uid, {
                    ...operation,
                    status: CrawlOperationStatus.SCHEDULED,
                }));
                return {
                    scheduled: true,
                    runs_at: new Date(startsAt).toISOString(),
                    urls,
                    name: operation.name,
                };
            }

            const task = await firstValueFrom(this.crawl.multiCrawlEnqueue(urls, operation));
            return { task_id: task.id, status: 'In Progress', urls };
        } catch (failure) {
            // The route's own refusals (402 for a lapsed plan, 503 for no queue)
            // are the honest answer, so they are handed to the model as text.
            return { error: failureLine(failure) };
        }
    }

    /**
     * The `/operations` row a chat-started job leaves behind.
     *
     * Kept minimal on purpose: the server owns `id`, `task_id`, `status` and the
     * author's uid, and overwrites whatever this sends for them.
     * @param {string} uid The owner.
     * @param {string[]} urls The targets.
     * @param {number} startsAt The scheduled time, or NaN to start now.
     * @return {CrawlOperation} The row to send.
     */
    private jobRow(uid: string, urls: string[], startsAt: number): CrawlOperation {
        return {
            type: 'playground',
            author: {
                uid,
                displayName: this.user()?.currProviderData?.displayName || 'anonymous',
            },
            name: urls.length === 1 ? `Chat · ${urls[0]}` : `Chat · ${urls.length} pages`,
            created_At: Date.now(),
            scheduled_At: Number.isNaN(startsAt) ? Date.now() : startsAt,
            urls,
            status: CrawlOperationStatus.READY,
            urlPath: '/chatai',
        };
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
             * The one STARTING action, and the reason `list_sessions` is offered
             * beside it: the model is told to reuse a live session, and the two
             * tools are what let it check rather than assume.
             *
             * `mode` is fixed to `dedicated` here rather than exposed as a
             * parameter. `byo` means "my own CDP endpoint", which needs a URL the
             * model would have to invent; a guessed one would point a paid lease
             * at a browser we do not control. `kind` and `workload` are narrowed
             * with a literal test instead of a cast, so a hallucinated value
             * falls back to the server's own default rather than reaching it.
             */
            case 'create_session': {
                const kind = args['kind'] === 'lightpanda' || args['kind'] === 'obscura'
                    ? args['kind']
                    : 'chrome';
                const workload = args['workload'] === 'code' ? 'code' : 'browser';
                const fresh = args['fresh'] === true;

                /**
                 * Reuse before creating. A description asking the model to check
                 * `list_sessions` first is a request, not a guarantee, and the cost
                 * of the model ignoring it is a second machine billing in parallel.
                 *
                 * The response carries `reused` so the model can TELL the user it
                 * picked up an existing browser instead of quietly presenting it as
                 * new -- a session may still hold their logins.
                 *
                 * shortcut: not atomic, so two tabs can still buy two machines;
                 * upgrade to a lease lookup keyed by uid when that shows up.
                 */
                return this.sessions.list().pipe(
                    switchMap(list => {
                        const live = fresh
                            ? undefined
                            : list.sessions.find(session => session.kind === kind);

                        return live
                            ? of({ status: 'ok', session: live, reused: true })
                            : this.sessions.create({ mode: 'dedicated', kind, workload });
                    }),
                );
            }
            /**
             * argv is rebuilt here rather than forwarded: a model can send a string,
             * a nested array or numbers, and the daemon refuses a blank program name.
             * Rebuilding keeps "what the route receives" the same shape no matter
             * what the model emitted, and `timeout` only rides along when it is a
             * real number -- the server clamps it either way.
             */
            case 'run_command': {
                const argv = Array.isArray(args['command'])
                    ? args['command'].map(part => String(part))
                    : [];
                const seconds = Number(args['timeout']);

                return this.sessions.exec(
                    String(args['session_id'] ?? ''),
                    argv,
                    Number.isFinite(seconds) && seconds > 0 ? seconds : undefined,
                );
            }
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
            /**
             * Text the MODEL composed, which `save_file` cannot express: that one hands
             * the platform a URL to fetch. `content` is required by the schema, so an
             * absent value is a bug in the schema rather than a case to default -- and
             * an empty string is refused by the route with a 400 the model can read.
             */
            case 'write_file':
                return this.storage.savePayload(
                    String(args['content'] ?? ''),
                    String(args['filename'] ?? ''),
                    args['content_type'] ? String(args['content_type']) : undefined,
                );
            /**
             * The job tools. Answered here rather than by a route because the body
             * is not the model's to compose: the route takes an `operation_data`
             * row, and the scheduled case writes a document instead of calling
             * anything. See `createJob` for what each shape does.
             */
            case 'create_job':
                return from(this.createJob(args));
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
    private recordTools(results: readonly ExecutedCall[]): void {
        const runs: ToolRun[] = results.map(result => ({
            name: result.call.name,
            summary: summariseToolResult(result.content),
            status: result.status,
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

    /**
     * Add one round's usage to the answer it produced.
     *
     * Accumulated rather than replaced: a turn can spend several rounds and each one re-sends the
     * conversation, so the sum is what the user is actually paying for. A turn that fails before a
     * round reports leaves the field absent, which is why the template renders nothing rather than
     * zeros.
     * @param {TokenUsage} spent What that round cost.
     * @return {void}
     */
    private recordUsage(spent: TokenUsage): void {
        this.messages.update(list => {
            const last = list[list.length - 1];

            if (!last || last.role !== 'assistant') {
                return list;
            }

            const total = last.usage ?? { input: 0, output: 0, cached: 0 };

            return [
                ...list.slice(0, -1),
                {
                    ...last,
                    usage: {
                        input: total.input + spent.input,
                        output: total.output + spent.output,
                        cached: total.cached + spent.cached,
                    },
                },
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
 * Where the conversation history is kept between reloads, and how much of it.
 *
 * Versioned, because the stored shape may change and an older value has to be
 * recognisable rather than misread. Capped, because this is a CACHE in a ~5MB budget
 * and not the record of the conversation: the newest turns are what a reload is for,
 * so the oldest are the right thing to lose. It is deliberately local to ONE browser
 * -- there is no cross-device history, and adding one means Firestore plus a
 * retention decision rather than another line here.
 *
 * `TRANSCRIPT_KEY` is the PREVIOUS single-conversation shape. It is still read once, to
 * adopt whatever the user already had, and is never written again: deleting a
 * conversation somebody was in the middle of is not a migration.
 */
const SESSIONS_KEY = 'deepscrape.chat.sessions.v1';
const TRANSCRIPT_KEY = 'deepscrape.chat.v1';
const TRANSCRIPT_MAX = 40;
/** Conversations kept. Twenty is the point where the newest turns still fit the budget. */
const SESSIONS_MAX = 20;
/** Longest title kept or rendered, so one pasted paragraph cannot fill the menu. */
const TITLE_MAX = 60;
/** Conversations the rail renders per page, and how close to its end counts as "reached". */
const RAIL_PAGE = 12;
const RAIL_TOLERANCE_PX = 48;

/**
 * One stored conversation.
 *
 * `at` is the moment of the last turn rather than creation, so the menu orders by recency
 * and a conversation being used stays at the top. `title` is derived from the first turn
 * and stored, rather than recomputed: a session whose first turn is later trimmed must not
 * be renamed by that.
 */
export interface ChatSession {
    readonly id: string;
    readonly title: string;
    readonly at: number;
    readonly messages: readonly ChatMessage[];
    /**
     * Pinned under the rail's `CHAT.PINNED` heading.
     *
     * Optional because it arrived after the format did: a conversation stored before this existed
     * has no field, and absent must read as "not pinned" rather than as a migration.
     */
    readonly pinned?: boolean;
}

/**
 * Whether a conversation answers a search.
 *
 * Title first, then the turns: a conversation is remembered by what was SAID in it as often as by
 * the question that opened it, and the title is only that question's first line. Case-insensitive,
 * and an empty needle matches everything so the caller needs no special case.
 * @param {ChatSession} session The conversation.
 * @param {string} query What the user typed.
 * @return {boolean} True when the conversation belongs in the filtered list.
 */
export function sessionMatches(session: ChatSession, query: string): boolean {
    const needle = query.trim().toLowerCase();

    if (!needle) {
        return true;
    }

    return session.title.toLowerCase().includes(needle) ||
        session.messages.some(message => message.content.toLowerCase().includes(needle));
}

/**
 * A tool run as it comes out of storage, before its status is normalised.
 *
 * `status` is `unknown` rather than `ToolRunStatus` on purpose: a transcript written before the
 * field existed has none, and a hand-edited one can hold anything.
 */
interface StoredRun {
    readonly name: string;
    readonly summary: string;
    readonly status?: unknown;
}

/** Whether a stored value is a tool run the chip can render. */
const isStoredRun = (value: unknown): value is StoredRun => {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const run = value as Partial<ToolRun>;
    return typeof run.name === 'string' && typeof run.summary === 'string';
};

/**
 * A stored run with a status the template can switch on.
 *
 * A missing status is `ok`, which is the only safe default: it says "this ran", and an old
 * transcript really did run its tools. Guessing `failed` would libel a conversation that worked.
 * @param {StoredRun} run The validated stored shape.
 * @return {ToolRun} The run, with a status the template can render.
 */
const toToolRun = (run: StoredRun): ToolRun => ({
    name: run.name,
    summary: run.summary,
    status: run.status === 'refused' || run.status === 'failed' ? run.status : 'ok',
});

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
/**
 * Whether a stored value is a usage record the template can render.
 *
 * Validated rather than trusted, for the same reason as `isStoredRun`: this comes back out of
 * `localStorage`, which any script on this origin can write. A missing or hand-edited record is
 * DROPPED, so an old transcript simply shows no cost line instead of `NaN`.
 * @param {unknown} value The stored field.
 * @return {value is TokenUsage} True when all three counts are real numbers.
 */
const isStoredUsage = (value: unknown): value is TokenUsage => {
    const usage = value as Partial<TokenUsage> | null | undefined;

    return (
        !!usage &&
        typeof usage.input === 'number' &&
        typeof usage.output === 'number' &&
        typeof usage.cached === 'number'
    );
};

/**
 * Whether a stored value is an attachment reference a request can use.
 *
 * Validated rather than trusted, for the same reason as `isStoredUsage`: this comes back out of
 * `localStorage`. The MIME type is checked against the two lists that reach a vendor content part,
 * because a type no dialect accepts is a 400 rather than a fallback. A reference with no key is
 * dropped too -- there is nothing to mint a link for.
 * @param {unknown} value The stored field.
 * @return {value is ChatMedia} True when the key and the type are usable.
 */
const isStoredMedia = (value: unknown): value is ChatMedia => {
    const media = value as Partial<ChatMedia> | null | undefined;

    return (
        !!media &&
        typeof media.key === 'string' &&
        media.key.length > 0 &&
        typeof media.name === 'string' &&
        typeof media.mime === 'string' &&
        (IMAGE_TYPES.includes(media.mime) || media.mime === PDF_TYPE)
    );
};

export const toChatMessage = (value: unknown): ChatMessage | null => {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const entry = value as Partial<ChatMessage>;
    const tools = Array.isArray(entry.tools) ? entry.tools.filter(isStoredRun).map(toToolRun) : [];
    const media = Array.isArray(entry.media) ? entry.media.filter(isStoredMedia) : [];

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

    return {
        id: entry.id,
        role: entry.role,
        content: entry.content,
        at: entry.at,
        tools,
        ...(media.length ? { media } : {}),
        ...(isStoredUsage(entry.usage) ? { usage: entry.usage } : {}),
    };
};

/**
 * A conversation's name, taken from what the user actually asked.
 *
 * Whitespace is collapsed because a pasted multi-line prompt otherwise renders as one broken run in
 * the menu, and the cut ends on an ellipsis so a shortened title reads as shortened rather than as
 * an oddly short question.
 * @param {readonly ChatMessage[]} messages The conversation, oldest first.
 * @return {string} The title, or '' when the conversation holds no text yet.
 */
export function sessionTitle(messages: readonly ChatMessage[]): string {
    const question = messages.find(
        message => message.role === 'user' && message.content.trim().length > 0,
    );

    // An assistant-led transcript still needs a name, so ANY non-empty turn is the fallback. Taking
    // the first non-empty turn outright would title the conversation with the assistant's words.
    const source = question ?? messages.find(message => message.content.trim().length > 0);
    const text = (source?.content ?? '').trim().replace(/\s+/g, ' ');

    return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1).trimEnd()}…` : text;
}

/**
 * An identifier for a new conversation.
 *
 * `randomUUID` is absent outside a secure context, so the fallback is time plus randomness rather
 * than a throw in the one path that runs while a user is mid-sentence.
 * @return {string} An id unique enough for a per-browser list.
 */
const newSessionId = (): string =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * A stored conversation, or null when it is not one.
 *
 * The value comes out of localStorage, so every field is re-validated and the title is re-capped:
 * a hand-edited row must not be able to put a megabyte into the menu. A conversation with no
 * readable turn is dropped rather than rendered as an empty row.
 * @param {unknown} value One entry of the stored array.
 * @return {ChatSession | null} The conversation, or null when it cannot be rendered.
 */
export function toChatSession(value: unknown): ChatSession | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const entry = value as Partial<ChatSession>;

    if (typeof entry.id !== 'string' || !entry.id) {
        return null;
    }

    if (typeof entry.title !== 'string' || typeof entry.at !== 'number') {
        return null;
    }

    if (!Array.isArray(entry.messages)) {
        return null;
    }

    const messages = entry.messages
        .map(toChatMessage)
        .filter((message): message is ChatMessage => message !== null);

    if (!messages.length) {
        return null;
    }

    return {
        id: entry.id,
        title: entry.title.slice(0, TITLE_MAX),
        at: entry.at,
        messages,
        // Only a literal `true` pins. Anything else in storage reads as unpinned, which is the
        // safe direction: a corrupted value must not pin a conversation the user never pinned.
        pinned: entry.pinned === true,
    };
}

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

    // 502 is the BFF saying the PROVIDER did not answer -- not a bug in our route and not
    // something the user's prompt caused. It gets its own sentence because the only useful
    // advice is "try again or switch model", which the generic server copy does not give.
    if (status === 502 || status === 503 || status === 504) {
        return 'upstream';
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
