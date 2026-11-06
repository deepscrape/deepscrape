# Design System: deepscrape — Marketing Landing

**Project ID:** deepscrape (Angular 20 · TailwindCSS v3 · Angular Material v20)
**Analyzed from:** `src/app/layout/landpage/*` (hero, features, use-cases, architecture, code-demo, pricing, social-proof, faq) · `src/styles.scss` · `tailwind.config.js` · `.github/skills/deepscrape-theme-template-skill/references/current-theme-map.md`

> This document is the semantic source of truth for generating new screens (Stitch or otherwise) that match the deepscrape marketing landing. Read it as a designer's brief, not a CSS spec. Every color carries a role; every radius is a material; every shadow has a mood.

---

## 1. Visual Theme & Atmosphere

**Atmosphere — "Deep Research Lab."** A dark-first, high-contrast glassmorphism system that feels like a precision instrument for the open web: near-black obsidian canvases (`#060606`, `#080808`) layered with luminous cyan→rose plasma orbs, faint architectural grid lines, and whisper-thin glass surfaces that float above the void. Density is moderate: generous hero whitespace, information-rich lower sections. In light mode the same system flips to a warm off-white (`gray-50` / `white`) with softened glass and barely-there grid lines — never garish, always studio-lit.

The mood should say: **the fastest, most trustworthy web-data engine, wrapped in calm, scientific luxury.** Cyan is the voice of *motion & the network*; rose is the voice of *intelligence & attention*.

---

## 2. Color Palette & Roles

| Descriptive name | Hex | Role |
|---|---|---|
| Obsidian Void (deep) | `#060606` | Primary dark section canvas (`section-dark`) |
| Obsidian Void (raised) | `#080808` | Alternate dark section canvas (`section-dark-alt`) |
| Mist Paper (light) | `#f8f8f8` (gray1) | Light primary canvas (`section-dark` in light mode) |
| Frost Paper (light-alt) | `#ffffff` (white) | Alternate light canvas |
| Frozen Fog (neutral ramp) | `#f8f8f8 → #12181b` (gray1→gray7) | Neutral text/surface ramp; body text uses mid-steps, borders use low-opacity steps |
| Data-Current Cyan | `#06b6d4` (cyan-500) / `#22d3ee` (cyan-400) | **Primary accent** — actions, links, network/orb glows, the "machine" voice. Dark text on cyan uses white |
| Plasma Rose | `#f43f5e` (rose-500) / `#fb7185` (rose-400) | **Secondary accent** — intelligence, AI, attention dots, proxy/captcha pills, "popular" tier |
| Aurora Blend | `from cyan-500 via cyan-600 to rose-500` (dark: `cyan-400 via cyan-500 rose-400`) | Signature **gradient text** for headline nouns & stats — the brand gradient |
| Glass White (light) | `rgba(255,255,255,.72)` (`--glass-bg`) | Light glass surface (16px blur, saturate 1.2) |
| Glass Ink (dark) | `rgba(22,22,22,.83)` (`--glass-bg-dark`) | Dark glass surface over orbs |
| Orb Cyan | `rgba(23,106,177,.20–.35)` | Soft radial **background glow**, top-right, behind hero terminal & sections |
| Orb Rose | `rgba(190,18,60,.15–.25)` | Soft radial **background glow**, bottom-left, counter-balance |
| Grid Line | `rgba(217,217,217,.06–.12)` | 40/80px architectural grid texture (strong = 40px) |

*Contrast note:* text is always `gray-900`/`white` for headings and `gray-600`/`gray-400` for body — AA compliant in both modes. Never introduce random blues/purples; when an interaction needs emphasis reach for cyan→rose first.

**One meaning per hue.** The app reuses a small set of accents, and each owns exactly one job — a
second meaning is how a palette starts to lie. The table below is what the code actually does
(counted in `docs/UI-CONSISTENCY-AUDIT.md` §13), not what it was meant to do:

| Hue | Means | Never |
|---|---|---|
| sky | **interactive** — links, focus rings, the button you press (`.cc-input` focus is `#0ea5e9`) | brand decoration, a status |
| cyan | **brand and live** — the logo, the loading bar, "this is running right now" | an ordinary action |
| violet | plans, credits, entitlement; also "scheduled" in the status map | an ordinary action |
| rose | danger, failure, a thing that will be destroyed | a decorative gradient stop |
| amber | waiting, paused, needs attention | an error |
| emerald | finished successfully | in progress |

Two blues, and the split is the point: **sky is what you click, cyan is what the product is.** A
surface that needs a seventh hue needs a different *surface*, not a new colour.


---

## 3. Typography Rules

- **Display / Headlines** — `cubano` (`font-display`), heavy weight, tight tracking. Headlines are large (hero up to `text-7xl`), sentence-cased, and often end on an **Aurora Blend gradient span**.
- **Body** — `sofia-pro` (`font-sans`), relaxed leading (`leading-relaxed`), `gray-600`/`gray-400`. Key nouns inside body copy are **bolded** in full-contrast (`text-gray-900 dark:text-white`) to create scannable hierarchy without color noise.
- **Overline / Pills** — tiny caps or `tracking-widest` uppercase micro-labels in muted neutral, always above section headings.
- **Code** — `attribute-mono` / mono stack for terminal, SDK snippets, and JSON demos; syntax highlighted in the terminal cyan/rose/yellow palette.
- **Mono accents** — the brand wordmark "DeepScrape" uses a stencil/mono face with a **drop-shadow gradient** treatment for a mechanical engraving feel.

---

## 4. Component Stylings

* **Buttons:**
  - *Primary:* pill-to-rounded-xl (`rounded-xl`) glass button filled with cyan→cyan-hover gradient intent; white text, `shadow-lg → shadow-xl`, subtle `-translate-y-0.5` lift and icon nudge on hover. The single most "magnetic" element on a section.
  - *Secondary / ghost:* same geometry, transparent glass (`glass-hover`), neutral text; on hover lifts 2px with a soft cyan-tinted shadow.
  - *Micro CTA pills:* pill-shaped (`rounded-full`) for "Start free", tier CTAs, FAQ links.
  - Motion: `transition-all duration-200`, hover `hover:-translate-y-0.5`.

* **Cards / Containers:**
  - Generous corner radius (`rounded-xl`/`rounded-2xl`). Surfaces are **glass** (16px blur) with a 1px hairline border (`rgba` white in dark, black in light) and a *whisper-soft diffused shadow* that deepens on hover (`--glass-shadow → hover`).
  - Optional **3-stop gradient border** wrapper (`with-gradient-border`) in cyan→violet→amber for feature cards, or colored 8px top border per pricing tier.
  - Icon tiles are small glass squares (`rounded-xl`, `w-11 h-11`) whose icon tint is the section's accent; they scale slightly + throw a colored glow on group-hover.
  - Hover language = lift + glow, never spin or flip.

* **Inputs / Forms:**
  - Glass-pill or glass input surfaces over section backgrounds; thin neutral borders in dark (`white/12`), barely-visible in light; accent (cyan) focus borders only where a Material field exists. Dark mode always uses `gray7`/glass fills.

* **Badges / Pills / Toggles:**
  - `glass-pill` = `rounded-full`, 12px blur, near-invisible border, tinted **colored text + dot** (cyan or rose). Used for feature badges, capability clouds, category tabs, and the monthly/yearly toggle.

* **Code / Terminal window:**
  - Full **glass terminal card** with macOS traffic lights, `rounded-xl`, cyan hairline border that brightens on hover, and a blur-glow halo behind that intensifies on hover. Tabbed mono code (Python / Node / cURL).

* **Backgrounds (non-interactive):**
  - Near-black `section-dark`/`section-dark-alt` (or gray-50/white light), plus **orbs** (large `blur-3xl` radial cyan/rose, `animate-pulse` w/ staggered delays) and faint **grid-lines** at 40/80px.

---

## 5. Layout Principles

- **Whitespace:** generous, even rhythm — sections pad `py-20 md:py-28`; content maxes at `max-w-7xl` centered (`px-4 sm:px-6 lg:px-8`), FAQ tighter at `max-w-4xl`, stat rows at `max-w-3xl`. The hero is a full-viewport, vertically-centered split (`lg:flex-row`) with 12–20px gutters.
- **Section cadence:** alternate `section-dark` / `section-dark-alt` so the page has a quiet pulse; each section opens with centered `glass-pill` overline → gradient H2 → sub-paragraph → content.
- **Composition rule:** single strong left or centered headline; visual evidence (terminal, image banner, SVG) on the right or directly under. Anchors `#features → #faq` all carry `scroll-mt-24` for fixed-header clearance.
- **Scroll delivery:** below-hero sections reveal with a 28px fade-up once ~12% clears the viewport (`appReveal`), reduced-motion safe. The fixed header fades in glass + a section-anchor pill nav after 100px of scroll.
- **Grid alignment:** cards sit on strict `grid-cols-1 md:2 lg:3` (features), `lg:4` (pricing), `md:2` (testimonials); equal-height via `h-full`, boundaries defined by glass hairlines rather than heavy strokes.
- **Responsive:** mobile stacks to single column with centered text (`text-center lg:text-left`), orbs soften, grid-lines stay, terminal stays full-width below copy.

---

## Design language cheat-sheet for generation

- Want it to feel like deepscrape? → **dark void + cyan/rose glass + faint grid + a glowing orb + gradient noun.**
- Accent order: cyan for actions/network, rose for AI/attention, **never purple** for primary surfaces.
- Radius language: `rounded-full` = pill · `rounded-xl/2xl` = gently/generously rounded · `rounded-lg` = subtle.
- Motion language: glass = calm 16px blur · shadows = whisper-soft diffused → deeper on hover · entrance = 28px fade-up · decorative = slow pulse orbs, no spin.
- Interaction accents: cyan→rose for CTAs; hover = lift 2–6px + glow, `duration-200/300`, `ease-out`.

_Product tie-in:_ the platform's AI chat is backed by a **webrain**-style live-web research agent — hero copy, badges, and capability pills should keep surfacing "ask → it browses → structured data out" with Claude/GPT/Groq provider chips.
