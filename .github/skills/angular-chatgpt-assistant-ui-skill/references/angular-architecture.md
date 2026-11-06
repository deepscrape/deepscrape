# Angular architecture and contracts

## Recommended component boundaries

Keep components small enough to reason about, but do not split every icon or text label into its own component.

```text
app/
  core/
    chat-data/
      chat-api.port.ts            # Typed boundary to the backend
      chat.models.ts              # Conversation/message/attachment types
      chat.store.ts               # Signal-based state facade
      chat-demo.adapter.ts        # Optional explicitly-mocked adapter
    theme/
      theme.models.ts
      theme.service.ts
      theme-presets.ts
  features/
    assistant/
      assistant.routes.ts         # Optional lazy route
      shell/
        assistant-shell.component.*
        assistant-sidebar.component.*
        assistant-topbar.component.*
      conversation/
        conversation-page.component.*
        conversation-list.component.*
        conversation-group.component.*
        message-list.component.*
        message-item.component.*
        assistant-markdown.component.*
        code-block.component.*
      composer/
        chat-composer.component.*
        attachment-list.component.*
        composer-tools-menu.component.*
      overlays/
        model-picker.component.*
        chat-actions-menu.component.*
        settings-dialog.component.*
        confirm-dialog.component.*
      shared/
        empty-state.component.*
        loading-indicator.component.*
        scroll-to-latest.component.*
```

Adapt names and placement to the repo's existing architecture. A small application may keep these folders flatter.

## Domain types

Use discriminated unions for message content and explicit state for generation. Example contract (adapt to existing APIs):

```ts
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type GenerationStatus = 'idle' | 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url?: string;
  previewUrl?: string;
  status: 'pending' | 'uploading' | 'ready' | 'failed';
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  attachments?: ChatAttachment[];
  status?: 'sending' | 'streaming' | 'complete' | 'failed';
  error?: string;
  editedAt?: string;
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  pinned?: boolean;
  archived?: boolean;
  projectId?: string;
}

export interface ChatRequest {
  conversationId: string;
  message: string;
  attachmentIds: string[];
  modelId?: string;
  toolIds?: string[];
}
```

Do not include fields that the real backend does not support. Preserve IDs and timestamps from the server when present; do not derive identity from array indexes.

## Transport port

Keep UI state independent of whether the backend uses HTTP, SSE, or WebSocket. A minimal port could look like:

```ts
import { Observable } from 'rxjs';

export interface AssistantStreamEvent {
  type: 'message-start' | 'text-delta' | 'message-complete' | 'error';
  messageId: string;
  delta?: string;
  error?: { code?: string; message: string };
}

export abstract class ChatApiPort {
  abstract listConversations(): Observable<Conversation[]>;
  abstract getMessages(conversationId: string): Observable<ChatMessage[]>;
  abstract sendMessage(request: ChatRequest): Observable<AssistantStreamEvent>;
  abstract stopGeneration(conversationId: string): Observable<void>;
  abstract renameConversation(id: string, title: string): Observable<void>;
  abstract deleteConversation(id: string): Observable<void>;
}
```

This is a UI boundary, not a demand to implement a backend. If the project already has a generated API client, use its types and adapt it behind a facade instead of creating duplicate contracts. Make cancellation explicit (for example, `AbortController` in a fetch adapter or unsubscribe semantics for an Observable transport).

## Signal store responsibilities

A `ChatStore` or feature facade should own:

- `conversations`, `activeConversationId`, `messagesByConversation`, `generationStatus`, `activeAssistantMessageId`, and `lastError` signals.
- Computed active conversation, active messages, grouped conversations, send eligibility, and generation state.
- Commands such as `createConversation`, `selectConversation`, `sendMessage`, `appendDelta`, `completeGeneration`, `stopGeneration`, `retryMessage`, `renameConversation`, `pinConversation`, and `deleteConversation`.
- Request cancellation and stale-response protection when the active conversation changes.

Keep ephemeral presentation state separate where practical: sidebar open, open menu, composer draft, theme picker visibility, and modal state can live in shell/component signals. Do not mirror every local boolean into a global store.

## Angular 18/19 guardrails

- Angular 18 and 19 support standalone components and signals. For an Angular 18 repo, use explicit `standalone: true`; Angular 19 defaults components to standalone, but explicit declaration can make intent clearer in a shared codebase.
- Use `@for (message of messages(); track message.id)` rather than array-index tracking for transcript content.
- Prefer `takeUntilDestroyed()` for imperative RxJS subscriptions in Angular-managed injection contexts.
- Keep SSR-safe theme persistence: guard `localStorage`, `matchMedia`, `window`, `document`, and `URL.createObjectURL` behind browser execution checks and clean up object URLs.
- If the app uses NgModules, integrate incrementally; do not migrate the whole app to standalone as an unrelated side quest.
- Verify exact package/API compatibility against the repository lockfile before installing CDK, markdown, syntax-highlighting, or icon dependencies.

## Suggested ownership map

| Concern | Owner |
|---|---|
| Sidebar visibility and selected overlay | Assistant shell |
| Conversation selection and CRUD | Chat facade/store |
| Transcript rendering | Message list + message item |
| Markdown and code rendering | Dedicated renderer component |
| Draft text and local attachment queue | Composer |
| Streaming transport | Chat API adapter + store |
| Palette/mode preference | Theme service |
| Dialog/menu focus and positioning | CDK or accessible local component |

## Anti-patterns

- A single `ChatComponent` owning layout, network calls, transcript, upload, settings, and all dialogs.
- Importing all of Angular Material solely to get a sidebar, button, or menu.
- Treating every stream token as a full application state reset.
- Storing the entire transcript as one giant string.
- Using `any`, array indexes as IDs, or DOM queries to locate messages.
- Calling a provider API directly from browser code with a secret key.
