# UI consistency audit — where the interface stops feeling like one product

Written after a graph pass over every frontend surface (24 964 nodes) plus the landing page as
the reference. It is deliberately short: each row is a defect, its evidence, and the smallest fix
that removes it. Ordered by how much it costs the eye, not by effort.

The two external rules used as the yardstick:

- **Material 3 motion** splits *spatial* motion (movement, may overshoot) from *effects* motion
  (colour, opacity — never overshoots), in three speeds: fast for small components, default for
  panels, slow for full-screen. One catch-all transition violates this by construction.
- **Tailwind** ships `motion-safe:` / `motion-reduce:` variants and `animate-pulse` as the
  documented skeleton idiom. Both are already available here; neither is used consistently.

---

## 1. A navigation rail that hides its own tabs — **fixed**

`playground.component.html` carried `overflow-x-hidden` + drag-to-scroll and nothing else. Seven
modes, four visible on a phone; the rest were unreachable-looking, with no scrollbar, no chevron,
no fade. `domain-seeder.component.html:45-71` had already solved it (drag + chevrons + edge fades).

Fixed by porting the seeder's affordances, driven by two signals on the existing scroller:
`showLeftScroller` / `showRightScroller` + `scrollModes()`. The chevrons are `aria-hidden` and out
of the tab order — every mode is already a focusable button, so they are a pointer affordance,
not a second control for a screen reader.

**Still open:** `app-tabs` (`tabs.component.html:1-40`) is a *third* rail (transform + swipe +
chevrons). Three implementations of one idea. Do not unify until a fourth appears — but the next
new rail must reuse one of them, not invent a fourth.

## 2. `transition-all` on 148 elements across 37 files — **overstated, corrected**

First written as if the count were the problem. It is not: `transition-all` is only harmful where a
*paper property actually changes* — `width`, `height`, `padding`, `margin`, `top`, `left` — because
those force layout every frame. On an element that only swaps colour and shadow (most of the 148)
it costs nothing visible, and rewriting it is churn.

What the sweep did find:

- `checkbox.component.html:11` — `transition-all duration-150 ease-linear` on the **visually hidden
  input** (`h-0 w-0 opacity-0`). Nothing can animate; the utilities were dead weight. Removed.
- `stinput.component.html:67` — the validity bar animates only its background colour, so
  `transition-colors` says what it means.

**The rule to apply when adding one:** transition the properties you change. `transition-colors` for
tint, `transition-shadow` for elevation, `transition-transform` for lift — and never `transition-all`
on an element whose size or padding is bound to state.

## 3. Loading states exist only where someone remembered

`loading-key` (the global skeleton class in `styles.scss:200`) is used in 10 templates:
`usage`, `dashboard`, `operations`, `workspace`, `machine-detail`, the three crawl-pack configs
and `crawlerpack`. It is **absent** from `billing/transactions`, `billing/passes`, `billing/rates`,
`billing/plans`, `billing/paymentmethods`, `settings/api-keys`, `user/alerts` and `chatai` — those
pages paint an empty frame, then jump to content. On a slow connection that is the difference
between "loading" and "broken".

Fix: apply the existing class to the first paint of each listed template. No component, no service.
**Correction, 2026-10-30:** this row originally named `billing/rates` and `settings/api-keys` as
bare. Both were already covered — `rates` through `app-result-envelope`, `api-keys` through an
inline skeleton — which is why the rule below matters more than the list.

There are two sanctioned async-state idioms, and a page must use the one its content is: **tool
results** use `app-result-envelope` (state / error / loading / idle / empty / retry; 8 surfaces),
**page data** uses `loading-key` blocks sized like the content they replace. What is not sanctioned
is a bare `@if (x.length === 0)` / `@if (x.length > 0)` pair, which covers neither state while the
observable is `undefined` — the page paints a header and then nothing.

**Done 2026-10-30:** `billing/transactions` (summary + invoices + payments), `billing/passes`,
`billing/paymentmethods`, `billing/plans`, `user/alerts` (see §8 — it also needed a real fix, not
just a skeleton).
**Correction, 2026-10-30 — `chatai` did not belong on this list.** Its sessions are restored
synchronously from `localStorage` in the constructor, so the transcript is never `undefined`: there
is no first paint to fill and a skeleton would be theatre. The one async list on the page is the
model catalogue, and the gap there was the opposite of a missing skeleton — an *empty menu* (the
trigger briefly names a model that is not yet a row). Fixed with `@empty` on that `@for` and one
new key, `CHAT.MODELS_LOADING`. Row closed; nothing remains.

## 4. Motion has no speed tiers and ignores reduced motion

Durations are mixed (150/200/300/500) with no rule; `animate-ping` (3 landing files), `animate-pulse`,
`animate-spin`, the hero caret and the tool marquee are not wrapped in `motion-safe:`. The landing
page does honour `prefers-reduced-motion` in `hero.component.scss`, the rest of the app does not.

Fix: wrap every decorative `animate-*` in `motion-safe:` (one class each), and adopt three named
tiers in component SCSS instead of ad-hoc numbers.
**Done differently, and smaller (2026-10-30):** one rule in `styles.scss` turns `animate-ping` and
`animate-bounce` off under `prefers-reduced-motion: reduce`. That covers all 8 sites in 5 files,
plus every future one, without touching a template. Loading spinners are deliberately excluded —
their motion *is* the information. The duration tiers remain open (cosmetic, not a defect).

## 5. Two different rhythm scales between the marketing site and the app

Landing sections: `py-20 md:py-28` inside `max-w-7xl mx-auto px-4 sm:px-6 lg:px-8`, with `appReveal`
stagger. App pages: `container mx-auto px-4 py-6` (`passes.component.html:1`) and `px-4 py-6`
elsewhere. The vertical rhythm halves at the product boundary, which is why the signed-in app reads
as a denser, unrelated product even though the palette matches.

Fix: one page-shell scale (`py-8 sm:py-10` for app pages) applied at the layout, not per page.

**Corrected 2026-10-30, and it was a near-miss.** `app-user-layout.component.html:397` carries
`px-4 py-2 pt-0 lg:px-20 3xl:px-32` — it supplies the **horizontal** padding and almost none
vertical. So a page needs no `px`/`container` at all (that is the double inset), but it does own its
vertical space. The `transactions` comment claimed "the layout supplies the padding", and when
passes and paymentmethods were matched to it the three pages lost their only top padding and sat
flush under the header. All three now read `space-y-6 py-6`.

The rule: **horizontal padding belongs to the shell, vertical to the page.** Any page root with
`px-*`, `p-*` or `container` is double-inset; any page root with neither `py-*` nor `p-*` is flush.

**Applied 2026-10-31.** Eight more roots, found by reading each page's *first element* rather than
by searching: `dashboard`, `settings/workspace`, `settings/storage`, `crawl-pack/machines` (detail
and history), `billing/rates` and `browser` gained `py-6`; `billing/plans` dropped its `px-4` (it
keeps `container mx-auto`, which is centring, not inset). Eight pages that were already right
(`profile my-6`, `general mt-5`, `playground mt-8`, `operation-detail mt-8`, `crawl-config pt-6`,
the three billing pages, `security`'s `form mt-4`) were left alone — the point is not uniformity of
class, it is that no page starts flush.

**A mechanical sweep for this rule does not work, and I tried one.** Grepping each page's first six
lines for `py-`/`p-` returned 44 rows, nearly all false: the window leaked classes off a child
(`general` "passed" because a card three lines down says `p-5`), an indented root inside an `@if`
looked like a page root, and marketing/service pages were flagged although they are not inside this
shell at all. Same class of error as §2 — a pattern that *looks* structural while reading text. The
reliable detector is the first element of the file, one page at a time.

## 6. Chat is the one surface with no designed states at all — **wrong, retracted**

This row was written from a search, not from the file. `chatai.component.html` has all three states
and always did: an empty state at line 204 (`CHAT.EMPTY_STATE` with the DS mark, centred in the
transcript's own height), a streaming state (`role="log"`, `aria-live="polite"`,
`[attr.aria-busy]="streaming()"`, a stop button, and a jump-to-latest pill at line 337), and the
nearest thing chat has to a "status tone" — the failure and tool-limit banners. `transition-all`
does not appear in it either.

The lesson is the same one §2 taught: a template searched for *absent* classes reads as bare even
when it is fully designed, because designed states are usually written as `@if` branches on data,
not as utility classes with memorable names. Read the branches before calling a page undesigned.

## 7. Colour drift: violet, cyan and rose are each doing two jobs

`violet` is the plans accent, and also the credit-pack card; `rose` is the danger accent, and also
a decorative gradient stop on landing cards and the seeder lock icon. Nothing is *wrong* to the
eye yet, but two meanings per hue is how a palette starts to lie.

Fix: one meaning per hue, written down — cyan = primary action, violet = plans/credits, rose =
danger/attention. No code change; a rule in `DESIGN.md`.
**Done 2026-10-31:** the rule is in `DESIGN.md` §2 as a three-row table with a column for what each
hue must *not* do. Nothing was recoloured — the audit's own finding was that nothing is visibly
wrong yet, and repainting working surfaces to satisfy a table is the kind of change that looks like
progress and reads as a regression.

---

## 8. An empty state that lied — **fixed**

`alerts.component.html:48` rendered "You're all caught up." whenever `filtered().length` was 0.
`NotificationCenterService.items` is empty for two different reasons — nothing was written, or the
snapshot has not answered yet — and the page asserted the first while the second was true. Every
visit to `/alerts` claimed there were no alerts, then filled in.

Fixed by separating the two: the service gained `hydrated` (set by the first snapshot callback,
empty or not, and by the signed-out branch), and the page shows sized row placeholders until then.
The general rule this stands for: **an empty state is a claim about the data, so it may only render
once something has answered.** Any `@if (!list.length)` without a "has answered" test ahead of it
has this bug.

## 9. Async regions announce nothing — **open**

`aria-live` appears in five templates in the whole app (`browser-frame`, `result-envelope`,
`admin-webrain`, `chatai`, `settings/storage`). Every list that fills in — transactions, passes,
payment methods, plans, alerts, the billing cards — is silent to a screen reader: nothing is
announced when the data arrives, and the placeholders I added are `aria-hidden`, which is correct
for the decoration but leaves the region with no voice at all.

The pattern to adopt, once per region (the live wrapper must exist *before* the data does, which is
why this is not a one-line edit on the `@if` I just added):

```html
<div aria-live="polite" [attr.aria-busy]="!(data$ | async)">… skeleton or content …</div>
```

Until then the honest description is: visually correct, audibly empty.

**Partly done 2026-10-30, with no new keys.** The pages that show a spinner and a label already say
"Loading…" on screen — adding `role="status"` to those rows makes the same text audible with one
attribute each and no markup growth (`settings/security`: sessions, trusted devices, activity). The
half that remains open is the *arrival* announcement: nothing says the data landed, because a live
region that is created together with its content is not announced.

**Also swept, and clean:** the §8 rule — every `@if (x().length === 0)` claim in the app has a
loading test ahead of it (`activeSessions`, `trustedDevices`, `activityTimeline`,
`phoneMfaFactors`, `totpFactors` all sit inside `@if (xLoading()) { … } @else { … }`). `alerts` was
the only instance of the bug, and it is fixed.

---

## 10. Dark mode is covered — **checked, three holes, fixed**

Two greps, because a light surface in dark mode is the one defect users report as "broken", not
"unpolished":

- **White surfaces without a `dark:` counterpart:** 9 lines, all false positives — `bg-white/25`,
  `bg-white/20`, `bg-white/15` are translucent chips on a *coloured* background (plan pills, step
  dots), and `security.component.html:723` is the 2FA QR frame, which must be white to scan. None
  touched.
- **Dark text without a `dark:` counterpart:** 6 lines, of which three were real — the same form
  label (`block text-sm font-medium text-gray-700`) with no dark variant, on the cookie and headers
  textareas (`browser-config`) and the JS-code textarea (`crawl-config`). On a dark card that is
  dark grey on dark grey. Fixed with `dark:text-gray-200`, which is what the field *directly above
  each label* already used — the tell that it was an oversight, not a choice. The other three are
  deliberate (`text-slate-700` on the tab selector underline renders no text; two onboarding
  classes sit on a coloured background).

The rule this leaves: **a class that sets a colour on a surface must set it for both themes in the
same string.** Every violation found was a missing twin, never a wrong value.

---

## 11. Keyboard focus was opt-in — **fixed**

`.cc-focus-ring` in `styles.scss` draws a proper `outline` on `:focus-visible`, but it is a class
each element has to remember. Any button that did not — the billing range pills
(`transactions.component.html:15`), the alert filters, the custom-credit chips, most landing links —
fell back to the browser default, or to nothing at all where a sibling utility set
`focus:outline-none` without a ring.

Fixed globally: `a:focus-visible, button:focus-visible, [role="tab"]:focus-visible,
[tabindex]:focus-visible` get a 2 px primary outline with 2 px offset. Form controls are excluded
on purpose — `.cc-input:focus` already draws a box-shadow, and an outline on top of it reads as a
double ring.

The rule this stands for: **an affordance that must be remembered per element is not a system.** If
the same class appears in 15 templates by convention, it belongs in `@layer base` once.

---

## 12. The app writes its card by hand 218 ways; the landing writes it once — **measured, not touched**

The landing and the public pages read as one designed thing. The signed-in app reads as consistent
too, but only *internally*: it has no card system, it has habits that happen to agree. Counting
every class string in `src/app/**/*.html` that carries a shadow gives the size of the problem:

| Class string | Uses |
|---|---|
| `rounded-2xl bg-gray-50 p-5 shadow-md dark:bg-gray6/80` | **34** |
| `rounded-2xl bg-white dark:bg-gray6 p-5 shadow-md` | 11 |
| `flex w-full max-w-3xl flex-col gap-2 space-y-2 rounded-2xl bg-gray-50 p-5 shadow-md dark:bg-gray6/80` | 8 |
| `bg-white dark:bg-gray7/50 border border-slate-200/60 … rounded-xl p-4 sm:p-6 shadow-sm` | 8 (+5 with a grid span) |
| `bg-white dark:bg-gray-800 rounded shadow-md p-4` | 7 |

**218 distinct shadow-bearing class strings.** Four card families, five corner radii, three border
treatments, and the same surface spelled with both `bg-gray-50` and `bg-white` depending on who
wrote the file.

The one compositional difference that actually shows is the top row: the app's dominant card is a
**flat grey fill with a heavy shadow and no border**. The landing's cards — and the app's own better
pages — pair a light surface with `shadow-sm` and a hairline border. Fill + weight, no edge, is the
combination that reads cheap; edge + soft shadow reads designed. That is the whole of "why the
landing looks better", and it is not a token: the theme's `boxShadow` scale is the Tailwind default
in both places, and the landing uses the same `shadow-md`/`shadow-sm` weights the app does.

**Deliberately not changed.** Adopting one recipe means editing 34 elements and then deciding which
of the other 184 get it too — a repaint of every surface in the app, chosen from a compiler that
cannot see it. The honest sequencing is: define `.app-card` once in `styles.scss` next to
`loading-key`, adopt it in the files already being touched for other reasons, and let the count fall.
When it is below ~40 hand-written variants, a sweep is a five-minute change instead of a redesign.

**Calibration done 2026-10-31 — one page, so there is something to look at.** `.app-card` exists in
`styles.scss` (`rounded-2xl border border-gray2 bg-gray-50 p-5 shadow-sm`, dark
`border-gray5 / bg-gray6/80`) and all six dashboard cards use it. That page is the reference: open
`/dashboard` in both themes and decide. Nothing else was migrated, so if the edge-plus-soft-shadow
recipe reads thin next to the landing — or the hairline is invisible on the app canvas — the whole
decision reverses with one `@apply` line, not 34 edits.

Verified in the emitted stylesheet rather than in the source, because `@apply` failing is silent in
every gate except the build's own CSS: `.app-card` emits `border-radius:1rem`, a 1px
`rgb(219 225 232)` border, `rgb(250 250 250)` fill, `1.25rem` padding, `shadow-sm`, **and** a
`.app-card:is(.dark *)` block. If a future edit drops the dark pair, the light card will show up on
the dark canvas — check the built CSS, not the SCSS.

**The sweep list, so the next pass is mechanical.** The old recipe appears 47 times in 12 files.
Adoption is now 23 elements: all six dashboard cards, all seven in `settings/general`, all seven in
`settings/workspace` (including the delete-confirm card, which keeps `w-full max-w-md`),
`settings/storage`, `browser-session-vault`, `machine-history`. What is left:

| File | Old-recipe occurrences |
|---|---|
| `settings/security` | 10 |
| `crawl-pack/machines/machine-detail` | 6 |
| `settings/profile` | 4 |
| `browser-session-panel` | 3 |
| `billing/transactions` | 3 |
| `admin/admin-machine-detail` | 2 |
| `billing/paymentmethods` | 2 |

Files that carry it **once** are safe to convert with a single unambiguous replace; files with 7–10
need per-element context because the class string is identical, so the edit tool cannot tell two
occurrences apart. The method that works: anchor on the card's own comment where there is one, else
on the first child plus its heading key (or icon name). That is how the two seven-card pages were
done in one pass each — 7 of 7 converted, 0 leftovers, `BUILD=0`, 10 of 10 specs green.

**The landing idea that was worth taking.** `listStagger` already existed (18 uses): `:enter`,
70 ms stagger, 320 ms `cubic-bezier(0.22, 1, 0.36, 1)`. The dashboard's four stat cards now use it,
so the numbers arrive the way the landing's sections do — import + one decorator line + one binding,
no new animation code. Dashboard spec: 5 of 5 pass with the trigger bound.

Two measurements that came back clean, recorded so nobody re-does them:

- **Page title scale is five values** (`4xl` 1, `3xl` 14, `2xl` 4, `xl` 6, `lg` 5) — but each family
  is internally consistent, and the apparent outlier (`settings/account` at `xl` against its
  children at `lg`) is the settings *shell*, which is supposed to sit one step above the page inside
  it. No defect.
- **Route transitions already exist** (`[@routeAnimation]` on the outlet), so the app is not static
  at the seam where the landing feels alive; the difference is inside the pages, not between them.

---

## 13. The platform speaks more colours than the palette admits — **counted, one fix, one correction**

Every colour utility in the templates, counted by hue. `src/app/pages/{user,admin,admin-analytics}`
is the signed-in app; `{home,marketing,legal,service}` is the public site:

| | app (782 kb of templates) | public (195 kb) |
|---|---|---|
| `gray-*` | **2775** | 527 |
| `slate-*` | **483** | 163 |
| `sky-*` | **503** | — |
| `cyan-*` | 248 | **144** |
| `green-*` / `emerald-*` | 321 / 102 | 93 / 12 |
| `red-*` / `rose-*` | 260 / 157 | 116 / 15 |
| `amber-*` | 167 | 22 |
| `blue-*` | 120 | 8 |
| `violet-*` / `purple-*` | 104 / 16 | 23 / 13 |
| `indigo-*` | 4 | 120 |

Three things fall out of that table:

**1. The app has two neutrals.** `gray-*` and `slate-*` are both in use, and slate is not spread
thin — 451 of its 483 uses are in **one** page, `admin-analytics`, with 117 more in `onboarding`.
Those two surfaces are a different grey world from every page beside them. Not repainted here (451
class strings is a repaint, and the page is admin-only); recorded so the next person does not
"discover" it and trust a page as a style reference.

**2. The app's interactive colour is sky, not cyan, and no document said so.** 503 `sky-*` against
248 `cyan-*`, and `styles.scss` has been quietly correcting the truth all along: `.cc-input:focus`
is `#0ea5e9` (sky-500), `.cc-focus-ring` is `#0284c7` (sky-600), with a comment explaining that
indigo was not in the theme. So the app is *already* built on two blues and the split is coherent —
**sky is what you click, cyan is what the product is** — but `DESIGN.md` claimed cyan for both,
which is why every new page guessed differently. `DESIGN.md` §2 now states the six-hue system the
code actually uses, including amber (waiting) and emerald (finished) which were also undocumented.

**3. The one clearly wrong surface was the loading bar — fixed.** `app.component.html` painted the
router progress bar with `[color]="'rgb(190 18 60)'"` — **rose-700, the danger red** — over a track
gradient of `from-indigo-500 via-purple-500 to-pink-500`. So every navigation in the product drew a
four-hue rainbow finished in danger red, at 4 px, above every page. It is now cyan-600 with a
`bg-cyan-100` / `dark:bg-cyan-950/40` track: brand colour, no error signal, two classes. (The
landing's `from-sky-400 via-blue-400 to-indigo-400` hero wash and the footer's `primary` gradient
were left alone — they are part of the public design that works, and an indigo tail inside a
working gradient is not the same defect as a red status bar.)

**Animation strategy, checked and adequate.** 13 distinct triggers are bound in templates:
`listStagger` (18 uses), `fadeInUp` (11), `expandCollapse` (6), `routeChildAnimation` (6),
`routeAnimation` (3), plus the landing's `appReveal` reveal directive (14 files) and eight smaller
ones. The app is not missing entrance motion — it has more of it than the public site. What it lacks
is a written duration/easing tier, which §4 already records as cosmetic, not a defect.

---

## 14. Three hygiene counts that no gate checks — **measured, not fixed**

Not design, but the same class of thing: the compiler has no opinion on any of it.

- **11 of 12 `target="_blank"` anchors carry no `rel`.** Only `billing/transactions:112` does
  (`rel="noopener"`). Modern browsers imply `noopener` for `_blank`, so this is convention rather
  than a live vulnerability — but the house convention exists in exactly one place, which means the
  other eleven read as "nobody checked". Sites: `app-monitor:141`, `crawl-result-item:213,236`,
  `seeder-results:46`, `serp-results:60`, `operation-detail:337`, `operations:411`,
  `security:1502`, `mcp-web-scraping:81,329,337`.
- **`cpack.component.html:5` has two `alt` attributes on one `<img>`** — `alt="user photo"` then
  `alt="User Avatar"`. One is dead and the parser picks; the element also carries `ng-img="true"`,
  `priority=""` and `[name]="…"`, none of which Angular or `NgOptimizedImage` reads (that needs
  `ngSrc`). Leftovers from a migration, invisible because nothing errors.
- **No `<img>` is missing `alt` outright.** Every remaining image has one, which is why this is a
  hygiene row and not an accessibility one.

Not fixed here because none of it changes what a customer sees, and a sweep of 11 anchors across 9
files is the kind of diff that should ride along with a real change to those files.

---

## 15. Typography looks drifted and is not — **measured, no change**

Font-family utilities, counted the same way as §13:

| | app | public |
|---|---|---|
| `font-mono` | 130 | 46 |
| `font-serif` | 30 | 0 |
| `font-body` | 27 | 0 |
| `font-sans` | 4 | 0 |
| `font-display` | 1 | 22 |

Read quickly, that says the app speaks four faces and the public site one. It does not, because of
what the tokens resolve to in `tailwind.config.js`:

- `body: ['sofia-pro', 'sans-serif']` and `sans: ['sofia-pro', 'sans-serif']` are **the same stack**,
  and sofia-pro is the default. So all 27 `font-body` and 4 `font-sans` occurrences change nothing —
  they are no-op aliases, most of them in `settings/security` (21+3) and `settings/profile` (6).
- `serif: ['Roboto Slab', 'serif']` is a real slab, and all 30 uses are inside the crawl-pack family
  (`crawl-config` 22, `crawl-results` 4, `browser-config` 2) — a deliberate voice for those three
  pages, not drift between siblings.
- `display: ['cubano']` is the landing headline face; its 22 public uses against 1 in the app is the
  one real difference, and it is the correct one: the app has no marketing headlines.

No change made. The trap is worth recording: `font-body` *reads* as "this page uses the body face"
and invites a "fix the inconsistency" that would touch 27 elements and alter nothing. If any of it
should go, it is the 31 dead classes, not the typography.

---

## 16. Onboarding spoke two accents and had six bindings that could not work — **fixed**

The first page a new account sees is also the only page built on a palette of its own: `primary-*`
(sky) for the rail, CTAs and the security note, **and `indigo-*` for the plan step's cards, badges,
labels and radios** — 16 lines of a second blue in the same wizard. Two blues is fine when they mean
two things (§13: sky is what you click); here they meant the same thing on adjacent screens.

Fixed by deleting the second accent rather than adding a rule: every `indigo-*` became `primary-*`
(`accent-indigo-600` → `accent-primary-600` on the radios, `text-indigo-900` → `text-primary-900` on
the enterprise heading, the enterprise card's hand-rolled `rgba(79,70,229,0.14)` glow → the same
`rgba(2,132,199,0.10)` the page's other info cards use). Four `indigo` utilities remain, all of them
`focus:border-indigo-400 focus:ring-indigo-200` inside `.cc-input` class lists — inert by design,
because `styles.scss`'s `.cc-input:focus` pseudo-class beats a utility and paints the sky ring.

**Six class bindings were malformed, so their shadow could never apply.** The attribute name
contained a space before the closing bracket:

```html
[class.shadow-[0_18px_40px_rgba(2,132,199,0.28)] ]="step() === item.id"
```

Three of them guarded the rail's active and completed states, three sat on the plan cards and the
billing-interval pills. Whatever the parser did with a name that contains whitespace, the class was
not reliably applied — the "selected" card was distinguished by its border alone. Two were replaced
with the house scale (`shadow-lg`) and four were repaired to valid arbitrary-value syntax, so the
intent now happens. This is the sort of defect no gate catches: `bun run build` compiles it happily,
and the page simply looks slightly wrong.

Also removed: a `text-green-700` on the shield icon inside a `bg-primary-100 text-primary-700` tile —
the one element in that box pointing at the success hue instead of the accent while its container
declared the opposite. And `transition-all` → `transition` on the two surfaces that only change
colour and shadow.

**Left alone, deliberately:** 167 `slate-*` neutrals (this page stands alone in its own flow, so
slate against the house `gray` ramp is never seen side by side — unlike §13's `admin-analytics`),
`green-*` for completed steps (a self-consistent choice across the rail), and the four inert focus
utilities. The page's elevation language — a coloured glow on cards and buttons — was kept: it is
used consistently on all eleven surfaces, and normalising it to the house scale is a redesign, not a
fix. `BUILD=0`, 14 prerendered routes.

---

## What this audit deliberately does not do

Restyle anything wholesale. Six of the seven rows are one-class-per-element or one-class-per-page
changes; the only structural item (three rails) is left alone until a fourth caller justifies a
primitive. Accessibility notes are inline where they matter (the chevrons) rather than as a
separate section, because that is where they get fixed.
