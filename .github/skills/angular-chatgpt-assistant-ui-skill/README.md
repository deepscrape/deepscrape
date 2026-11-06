# Angular ChatGPT-style Assistant UI Skill

A reusable Agent Skill for building a ChatGPT-style assistant frontend with Angular 18/19 and original product palettes.

## Contents

- `SKILL.md` — activation instructions and required workflow.
- `references/angular-architecture.md` — component boundaries, typed contracts, signal-store responsibilities, Angular guardrails.
- `references/visual-and-interaction-spec.md` — responsive layout, sidebar, transcript, composer, menus, and UX behavior.
- `references/palette-system.md` — semantic token contract, six sample accent palettes, persistence and palette picker guidance.
- `references/acceptance-checklist.md` — implementation, responsive, behavioral, theme, security, and accessibility QA.
- `references/sources.md` — web research and documentation links.

## Install/use

Copy the `angular-chatgpt-assistant-ui` directory into the skills folder supported by your coding agent (for example, a project-level `.agents/skills/` directory if supported). Keep the directory name aligned with the `name` field in `SKILL.md`.

Ask the coding agent to build or improve the assistant UI in the existing Angular repository. It should inspect the repository first and read the reference files relevant to the requested work.
