---
name: angular-chatgpt-assistant-ui
description: Build a polished, responsive ChatGPT-style assistant frontend using Angular only. Use when creating or improving an Angular 18/19 AI chat interface with conversation navigation, a streaming-ready chat workspace, rich composer, responsive sidebar, settings, and independently configurable light/dark color palettes.
compatibility: Angular 18 or 19, TypeScript, standalone components, browser UI; adapt to the repository's installed versions and existing conventions.
---

# Angular ChatGPT-style Assistant UI

Build a high-fidelity assistant frontend with the interaction model and layout quality of ChatGPT, but with the product's own name, icons, typography, and theme palettes. Treat ChatGPT as a behavioral and layout reference, not as a source of copied branding or assets.

## Mission and boundaries

- Implement the **frontend UI in Angular only**. Do not introduce React, Vue, Next.js, or a second frontend runtime.
- Default target: the user's existing Angular 18/19 application. Inspect `package.json`, `angular.json`, routing, styles, and existing component conventions before changing anything. Do not upgrade Angular or replace the build system as part of a UI task.
- Build the complete interaction shell, not a static screenshot: sidebar, conversation workspace, composer, menus, theme picker, responsive states, loading/empty/error states, and keyboard behavior must work.
- Keep data transport behind typed Angular service contracts. A backend, model, authentication flow, persistence API, or real AI generation is **out of scope** unless separately requested. A local demo adapter is acceptable only when clearly identified as mock data.
- Use the project's current styling stack. Prefer semantic CSS custom properties / SCSS. Do not add Angular Material just for styling. Use Angular CDK selectively if it is already installed or clearly justified for overlays, focus management, or scrolling.
- Preserve existing application architecture, routing, authentication, API clients, linting, and test conventions.

## Required workflow

1. **Inspect before editing.** Check Angular/TypeScript versions, standalone-vs-NgModule setup, router, state management, CSS strategy, icon library, SSR/hydration, tests, and existing reusable components. Summarize the current conventions briefly.
2. **Map the existing app.** Identify the app shell, route entry, global styles, shared UI, and any existing chat/domain models. Extend rather than duplicate them.
3. **Define the visual system first.** Establish semantic design tokens and at least four palette presets before styling individual components. Theme colors must never be scattered as hard-coded values through component CSS.
4. **Design the component tree and typed contracts.** Keep shell/navigation, conversation rendering, composer, overlays, and state/transport separate. Avoid one giant component.
5. **Implement in vertical slices.** Build shell + responsive sidebar; then empty state + message list; then composer and message actions; then menus/settings/theme picker; then polish states and keyboard/a11y behavior.
6. **Make every visible control real.** Buttons, menus, toggles, tool chips, tabs, and palette swatches must perform a meaningful UI action. Do not ship decorative controls that look interactive but do nothing.
7. **Verify at desktop, tablet, and mobile widths.** Run the project's build, lint, and tests. Fix console errors, overflow, focus issues, and visual regressions. When screenshot tooling is available, inspect real rendered screenshots rather than relying on CSS intuition.
8. **Report scope honestly.** Separate implemented frontend behavior from mock behavior and backend integration still required.

## Visual target

Use a familiar assistant-app composition:

- Desktop: a left conversation sidebar and a flexible main workspace. The sidebar may collapse to a narrow rail or become a floating/dismissible panel. The workspace owns the top bar, scrollable conversation, and bottom composer.
- Empty/new chat: a centered welcome heading, short supporting text, and a prominent composer. Optional prompt suggestion cards may appear below it.
- Active chat: a centered readable message column with distinct user and assistant treatments, rich response content, code blocks, citations/links, and message-level actions.
- Composer: a rounded, elevated or bordered container with a multiline input, attachment control, tool/mode entry, and a clear send/stop affordance. It must remain usable while the conversation scrolls.
- Navigation: new chat, chat search, recency groups, optional projects, selected conversation, contextual actions, profile/settings entry.
- Use restrained surfaces, consistent spacing, subtle borders, carefully controlled shadow, clear hover/focus/pressed states, and strong text hierarchy. Avoid a generic dashboard-card aesthetic.
- Match the behavior and density of a modern assistant product, but use original product branding and palette presets.

See [references/visual-and-interaction-spec.md](references/visual-and-interaction-spec.md) for the detailed screen and interaction requirements.

## Angular implementation rules

- Use standalone components and explicit imports, with `standalone: true` where compatible with the installed Angular version. Angular 19 makes standalone the default; Angular 18 projects should declare it explicitly.
- Prefer `signal`, `computed`, and `effect` for local synchronous UI state. Use RxJS for asynchronous streams, cancellation, and transport events; bridge streams to signals only at clear boundaries.
- Use typed interfaces/unions for conversation, message, attachment, tool, generation, and theme state. Never model core chat state as `any` or unstructured nested objects.
- Use `@if`, `@for`, and `@switch` where supported by the installed version. Always provide stable identity tracking for repeated messages, chats, attachments, and menu items.
- Use `inject()` and functional providers in accordance with the current project style. Keep components focused on rendering and user intent; move state transitions and transport logic into services/facades.
- Use Reactive Forms only where a real form model/validation is needed. A simple chat composer can use a controlled textarea and signal without an unnecessary FormGroup.
- Lazy-load secondary settings or project routes when appropriate. Do not lazy-load tiny components just to increase architectural complexity.
- Keep all subscriptions lifecycle-safe (`takeUntilDestroyed`, `async` pipe, or signal interop). Cancel stale search/generation requests and handle stream completion, abort, and error states.
- Keep DOM access minimal. Prefer template bindings and Angular/CDK primitives over manual DOM mutation. If SSR is enabled, isolate browser-only APIs and avoid hydration mismatches.

See [references/angular-architecture.md](references/angular-architecture.md) for recommended boundaries, models, and a practical directory layout.

## Palette and theme requirements

- Implement **semantic tokens**, not component-specific color literals. At minimum define tokens for app canvas, sidebar, primary/secondary surfaces, elevated surface, primary/secondary text, muted text, borders, accent, accent hover, focus ring, user message, assistant surface, code surface, danger, success, and warning.
- Separate `mode` (`light`, `dark`, `system`) from `palette` (`graphite`, `ocean`, `violet`, `forest`, `ember`, etc.). A palette changes the accent personality; mode controls the surface/text contrast system.
- Provide a theme picker with visible swatches/previews and immediate application. Persist the user's selection safely in browser storage, with a default when storage is unavailable. Avoid reading `localStorage` at module evaluation time or during SSR.
- Theme all UI states: hover, selected, focus, disabled, tooltips, code blocks, menus, dialogs, skeletons, and scrollbars. Do not make the theme picker the only themed area.
- Ensure text and controls remain legible across every palette. Do not rely on color alone to communicate state.

See [references/palette-system.md](references/palette-system.md) for token names, sample palettes, and implementation patterns.

## Core functional requirements

Implement these as real frontend states/interactions:

- Sidebar open/collapsed state, mobile overlay/dismiss, new chat, active chat selection, chat search, recency grouping, and contextual chat actions (rename, pin/favorite, archive/delete with confirmation where appropriate).
- Empty state, loaded conversation, user/assistant message roles, streaming/in-progress state, retry/error state, and a scroll-to-latest affordance when the user is not already at the bottom.
- Composer with multiline input, Enter-to-send, Shift+Enter newline, disabled/empty submit state, attachment selection and removable previews, paste/drop where feasible, and send/stop control states.
- Message actions such as copy, retry, edit user prompt, and optional feedback controls. Actions must update the UI or invoke a typed output event.
- Model/mode selector and tool menu as configurable UI options. Do not imply that selecting a model/tool changes a real model unless a backend adapter implements it.
- Settings surface with appearance mode, palette, density or text-size preferences where useful, and keyboard shortcut/help information.
- Responsive states: desktop pinned/collapsible sidebar; tablet compact navigation; mobile floating sidebar/sheet with proper dismiss behavior and composer-safe-area handling.

A full interaction/state matrix is in [references/visual-and-interaction-spec.md](references/visual-and-interaction-spec.md).

## Quality, accessibility, and security gates

- Use semantic landmarks and elements (`aside`, `nav`, `main`, `section`, `form`, `button`, `textarea`). Every icon-only control needs an accessible name and tooltip where appropriate.
- All interactions must be keyboard reachable. Provide visible focus indicators, sensible focus restoration after dialogs/menus, Escape-to-dismiss behavior, and correct focus trapping for modal dialogs.
- Announce meaningful asynchronous updates (for example, new assistant response or generation failure) with appropriate live-region behavior without making the entire transcript excessively chatty.
- Respect `prefers-reduced-motion`; avoid flashing, excessive animation, and layout-shifting streaming effects.
- Meet WCAG AA contrast for normal text and interactive states. Test palette combinations, not just the default theme.
- Treat model output, filenames, URLs, and pasted content as untrusted. Render Markdown through a maintained parser/sanitizer pipeline; do not bind raw model HTML with `[innerHTML]` or bypass Angular sanitization casually.
- Validate attachment type/size in the UI for usability, but treat backend validation as mandatory. Revoke temporary object URLs when previews are removed or the component is destroyed.
- Never place provider API keys or secrets in Angular environment files or browser code. The UI calls an application backend through a typed client.

## Performance and polish

- Keep the transcript as the primary scroll container; the sidebar and composer should not cause document-level scroll traps.
- Avoid calling `scrollIntoView` on every streamed token. Batch updates/scroll work and only auto-follow while the user is already near the bottom; otherwise show a jump-to-latest affordance.
- Track messages by stable ID. Do not rerender the entire conversation on every stream chunk if the architecture can update only the active assistant message.
- Keep initial UI dependencies lean. Add markdown/highlighting/math/diagram libraries only when required by scope, and lazy-load expensive renderers when feasible.
- Avoid unnecessary global listeners, repeated layout reads, nested scroll areas, excessive blur/backdrop filters, and huge animation stacks.
- Use skeletons for true loading states, not as decoration. Include empty, loading, streaming, error, retry, disabled, and offline states.

## Definition of done

A task is complete only when:

- The app builds with the existing Angular toolchain.
- The main UI renders correctly at desktop, tablet, and mobile breakpoints.
- The sidebar, navigation, composer, theme picker, core menus, and message actions work as demonstrated.
- Light/dark/system modes and at least four distinct accent palettes work across the complete interface and persist safely.
- Keyboard navigation, focus visibility, dialog/menu dismissal, reduced motion, and contrast have been checked.
- No visible control is inert, no mock capability is presented as a working backend feature, and no secret is exposed in the browser.
- Build/lint/tests are run where available, and any remaining failures or limitations are stated.

## Reference files

Load only the references needed for the current task:

- [Angular architecture and contracts](references/angular-architecture.md)
- [Visual and interaction specification](references/visual-and-interaction-spec.md)
- [Semantic palette system](references/palette-system.md)
- [Implementation and acceptance checklist](references/acceptance-checklist.md)
- [Research sources](references/sources.md)
