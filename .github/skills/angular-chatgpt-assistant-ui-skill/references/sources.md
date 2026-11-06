# Research sources

Research checked on 2026-10-31. Product UI evolves, so re-check release notes before attempting a pixel-specific recreation.

## ChatGPT interaction reference

- [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) — current product changes. The October 2026 notes describe a redesigned floating sidebar, recency-limited sidebar with an all-conversations flyout, settings placement, changes to new-chat navigation, and a revised composer/scroll presentation.
- [ChatGPT on the web](https://learn.chatgpt.com/docs/web) — current top-level product workflows and navigation concepts.
- [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt) — projects grouping chats, files, and instructions; useful as an optional pattern if the target product needs it.

Use these as UX references, not as a reason to hard-code ChatGPT branding or assume every account has the same feature set.

## Angular implementation reference

- [Angular components](https://angular.dev/guide/components) — component composition and standalone component conventions.
- [Angular v18 standalone components](https://v18.angular.dev/guide/components/importing/) — standalone import model and Angular 18 guidance.
- [Angular signals and RxJS interop](https://angular.dev/ecosystem/rxjs-interop) — bridging signals and Observable streams.
- [Typed reactive forms](https://angular.dev/guide/forms/typed-forms) — typed form models when a proper form group is needed.
- [Lazy-loaded routes](https://angular.dev/best-practices/performance/lazy-loaded-routes) — route-level code splitting.
- [Angular accessibility](https://angular.dev/best-practices/a11y) — accessibility guidance and CDK a11y primitives.
- [Angular CDK Overlay](https://github.com/angular/components/blob/main/src/cdk/overlay/overlay.md) — connected overlays, menus, popovers, and global overlays.
- [Angular theming](https://github.com/angular/components/blob/main/guides/theming-your-components.md) — CSS variables/system-token approach in Angular Material; this skill deliberately uses app-owned semantic tokens rather than requiring Material.
- [Angular security](https://angular.dev/best-practices/security) — sanitization and DOM security guidance.
- [Angular hydration](https://v19.angular.dev/guide/hydration) — SSR hydration considerations.

## Skill packaging reference

- [Agent Skills specification](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx) — directory shape, required YAML frontmatter, and optional references/assets.

## Use of third-party examples

The search surfaced small Angular ChatGPT clone repositories, but they are learning projects with dated Angular versions and/or limited feature scope. Do not use them as an architectural baseline. Prefer the official Angular guidance above and inspect the target repository's installed versions before choosing dependencies.
