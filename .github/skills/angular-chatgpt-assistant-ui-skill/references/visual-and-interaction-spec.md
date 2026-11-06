# Visual and interaction specification

## 1. Application shell

### Desktop layout

- Full viewport-height application shell; avoid body scrolling when the transcript is the intended scroll surface.
- Sidebar width target: 250–290 px when expanded; compact rail target: 56–72 px. Treat these as starting values, not rigid constraints.
- Main workspace uses remaining width and a centered reading column. Keep conversation content readable at roughly 680–820 px depending on message type and viewport.
- Top bar stays visually quiet: sidebar toggle, current workspace/model label, and conversation actions. Do not crowd it with dashboard metrics.
- Composer remains anchored to the lower workspace edge, with a subtle background fade/surface treatment so content scrolling beneath it remains readable.

### Responsive behavior

- Wide desktop: pinned sidebar by default, with collapse/expand control.
- Tablet: sidebar can collapse to a compact rail or a floating panel depending on available width.
- Mobile: use a floating drawer/sheet; tapping a conversation closes it. Provide backdrop, Escape dismissal, touch-safe controls, and safe-area padding around the composer.
- Never let a fixed composer cover the last message; add content bottom padding based on composer height.

## 2. Sidebar

Required sections:

1. Product mark/name and new-chat action.
2. Search chats.
3. Optional top-level navigation (for example, Projects or Library) only when the product supports those destinations.
4. Conversation history grouped by relative recency: Today, Yesterday, Previous 7 days, Previous 30 days, and older. Make grouping timezone-aware and avoid brittle string date comparisons.
5. Account/profile and settings entry near the bottom.

Interactions:

- New chat clears active selection and opens the empty state.
- Selecting a conversation updates route/state and closes the mobile drawer.
- Search filters conversation titles and optionally message content; show empty/no-results state.
- Each conversation row has selected, hover, focus, and contextual-menu states.
- Context actions: rename, pin/unpin, archive, delete. Confirm destructive deletion and expose undo only if actual restore semantics exist.
- Sidebar collapse state must not destroy its active conversation selection.

## 3. Empty/new-chat state

- Center a welcome title and supporting one-line prompt above the composer.
- Show 3–4 prompt starters only if they help users discover capabilities. Clicking one populates the composer or sends it only when that behavior is explicit.
- Keep the empty state visually calm; it should not resemble a marketing dashboard.
- The composer should be the strongest focal point.

## 4. Conversation view

- Render a scrollable transcript with a stable message order and readable max width.
- User and assistant messages must have distinct but subtle treatments. Avoid oversized chat bubbles if the design is closer to a document-like assistant transcript.
- Assistant content supports paragraphs, headings, ordered/unordered lists, tables where needed, inline code, fenced code, links, blockquotes, and optional citations.
- Code blocks have language label, copy action, horizontal overflow handling, and readable line-height. Do not force syntax highlighting if it materially harms loading or accessibility.
- Tool/activity cards are separate semantic message parts; do not flatten tool output and final assistant text into one arbitrary HTML blob.
- Message actions appear on hover and keyboard focus, not hover alone. Keep controls reachable on touch devices.
- Long responses should wrap safely; wide tables/code can scroll inside their own region without pushing the overall page width.

Message actions (minimum):

- Assistant: copy response, regenerate/retry when supported, optional positive/negative feedback.
- User: edit and resubmit; copy optional.
- Failed message: show clear error state and retry affordance.

## 5. Composer

Required elements:

- Multiline text input with accessible label/placeholder.
- Attachment button and removable attachment chips/previews.
- Optional tool/mode menu and model selector if those concepts exist in the product.
- Send action when idle; stop-generation action while a response is streaming.
- Small helper text for supported files/privacy only when accurate.

Keyboard behavior:

- Enter sends when the draft is non-empty and IME composition is not active.
- Shift+Enter inserts a newline.
- Do not intercept Enter while an IME composition is in progress.
- Escape closes the open composer menu before it clears focus or changes page state.
- Disable send for empty/whitespace-only drafts or invalid attachments.

Attachments:

- Support file picker, removable previews, upload/progress/failure states, and optional drag/drop or paste.
- Show filename, readable size, and type-specific preview when safe.
- Handle rejected file types/size without losing the draft.
- Use temporary object URLs only for local previews and revoke them on removal/destruction.
- Do not imply that a file is uploaded or analyzed until the backend confirms it.

Streaming:

- When generation starts, create/mark the assistant message as streaming and switch the send affordance to stop.
- Append deltas to the active message without reordering earlier messages.
- On completion, finalize message state and restore the send affordance.
- On error, preserve partial content if appropriate and show retry/error details.
- Stop must cancel the active request/stream where supported; otherwise label it as a UI-only demo control.

## 6. Menus, pickers, and settings

- Use consistent menu geometry, focus management, Escape dismissal, outside-click behavior, and keyboard navigation.
- Model selector lists model name and optional capability label. Do not present a model as available when it is not configured by the backend.
- Tool picker shows enabled/disabled states and a short description; avoid implying unsupported tools are active.
- Theme settings expose mode (Light, Dark, System) and a grid/list of named palette previews.
- Settings may expose density, text size, shortcuts, and account-level preferences only when they have real behavior.
- For custom menus/popovers/dialogs, prefer Angular CDK Overlay/A11y if available and compatible. Otherwise implement full focus and dismissal semantics yourself.

## 7. Visual detail checklist

- Consistent spacing scale (for example 4, 8, 12, 16, 24, 32, 48 px).
- A restrained radius scale (small controls, standard cards/menus, large composer/dialog surfaces).
- One typography family or a deliberate system stack, with clear body/code distinction.
- Muted border contrast and a consistent elevation strategy.
- Real hover, pressed, disabled, selected, loading, and focus styles.
- Smooth but short transitions; reduced-motion alternative.
- No arbitrary gradients, excessive glassmorphism, rainbow accents, or random icon styles.
- No horizontal page overflow at 320 px viewport width.
