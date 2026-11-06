# Implementation and acceptance checklist

## Before coding

- [ ] Read `package.json`, `angular.json`, `tsconfig`, router, global styles, and existing UI components.
- [ ] Confirm Angular major version and whether the app uses standalone components or NgModules.
- [ ] Identify existing icon, typography, CSS utility, state, and test libraries.
- [ ] Confirm whether SSR/hydration is enabled.
- [ ] Identify whether a chat API client already exists; do not duplicate it.
- [ ] Confirm the task is frontend-only or explicitly includes backend wiring.

## Layout and responsive QA

- [ ] Desktop: expanded and collapsed sidebar.
- [ ] Tablet: no overlap between sidebar and workspace.
- [ ] Mobile: drawer opens/closes, backdrop and Escape work, selecting a chat closes the drawer.
- [ ] 320 px narrow viewport: no document-level horizontal overflow.
- [ ] Long response, long URL, wide code block, and wide table do not break the workspace.
- [ ] Composer does not cover the final transcript content.
- [ ] Mobile keyboard and safe-area behavior do not hide the send action.

## Behavior QA

- [ ] New chat, switch chat, search, rename, pin, archive, delete/confirm.
- [ ] Empty state and conversation state both render correctly.
- [ ] Enter sends, Shift+Enter inserts newline, IME composition is respected.
- [ ] Attachment preview/removal/error works and temporary URLs are cleaned up.
- [ ] Send/stream/stop/completed/error/retry states are distinct and correct.
- [ ] Scroll auto-follow stops when the user scrolls upward; jump-to-latest appears.
- [ ] Copy feedback is visible; message controls work on touch and keyboard.
- [ ] Menus/dialogs close on Escape and outside click according to expected behavior.
- [ ] No visible button is inert.

## Theme QA

- [ ] Light, dark, and system modes.
- [ ] At least four palettes (recommended six) with immediate application.
- [ ] Preference persists after reload in the browser.
- [ ] Invalid/missing storage value safely falls back to defaults.
- [ ] Sidebar, buttons, menus, dialogs, composer, code blocks, selected states, skeletons, and toasts all use tokens.
- [ ] Text/control contrast checked in every palette-mode combination.
- [ ] OS mode changes are reflected when `system` is selected.

## Accessibility/security QA

- [ ] Logical landmark/heading hierarchy.
- [ ] Accessible names for icon-only buttons and useful tooltips.
- [ ] Full keyboard path; visible focus ring.
- [ ] Dialog focus trap and focus restoration.
- [ ] Screen-reader announcements for important generation/error states.
- [ ] Reduced-motion preference respected.
- [ ] Markdown and links are safely rendered; no raw untrusted HTML bypass.
- [ ] URL schemes and attachment metadata are validated.
- [ ] No provider secret is included in the frontend bundle.

## Final verification

- [ ] Run the repository's build command.
- [ ] Run lint and relevant unit/component tests.
- [ ] Run browser/e2e tests if configured.
- [ ] Inspect at least one desktop and one mobile screenshot if tooling exists.
- [ ] Check console/network errors.
- [ ] Report changed files, implemented behavior, tests run, mock-only areas, and backend work remaining.
