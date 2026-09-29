import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostBinding, effect, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormsModule, Validators } from '@angular/forms';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { TranslateModule } from '@ngx-translate/core';
import { MarkdownModule } from 'ngx-markdown';
import { ClipboardbuttonComponent } from 'src/app/core/components/clipboardbutton/clipboardbutton.component';
import { DropdownComponent } from 'src/app/core/components/dropdown/dropdown.component';
import { setAIModel } from 'src/app/core/functions';
import { FormControlPipe } from 'src/app/core/pipes';
import { AiAPIService } from 'src/app/core/services';
import { AIModel } from 'src/app/core/types';

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface ChatRequest {
    provider: 'claude' | 'openai';
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
        return { provider: 'claude', messages };
    }

    return {
        provider: 'openai',
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

    /** Filled by `setAIModel`; the dropdown renders this array directly. */
    readonly model: AIModel[] = [];

    readonly modelAI = new FormControl<AIModel>(
        { name: 'claude-3-5-haiku-20241022', code: 'claude' },
        { nonNullable: true, validators: [Validators.required] },
    );

    private readonly ai = inject(AiAPIService);
    private readonly destroyRef = inject(DestroyRef);
    private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

    readonly messages = signal<ChatMessage[]>([]);
    readonly draft = signal('');
    readonly streaming = signal(false);
    readonly failed = signal(false);

    private readonly system = "You are deepscrape's assistant. Reply in concise markdown.";

    constructor() {
        setAIModel(this.model);

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

        const stream = request.provider === 'claude'
            ? this.ai.sendToClaudeAI(request.messages, this.modelAI.value.name, this.system)
            : this.ai.sendToOpenAI(request.messages, this.modelAI.value.name);

        stream
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                // Each emission is a DELTA, not the accumulated text.
                next: chunk => this.appendToReply(chunk?.content ?? ''),
                error: (error: unknown) => {
                    console.error('AI chat stream failed:', error);
                    // Drop the empty placeholder, or the transcript keeps a spinner forever.
                    this.messages.update(list =>
                        list[list.length - 1]?.content ? list : list.slice(0, -1),
                    );
                    this.failed.set(true);
                    this.streaming.set(false);
                },
                complete: () => this.streaming.set(false),
            });
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
