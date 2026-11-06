# Semantic palette system

## 1. Token contract

Use a stable token contract so component CSS never depends on a specific palette's raw hex values.

```css
:root {
  color-scheme: light;
  --app-bg: #f7f7f8;
  --sidebar-bg: #f0f1f2;
  --surface: #ffffff;
  --surface-raised: #ffffff;
  --surface-hover: #eceef0;
  --surface-selected: #e4e7eb;
  --text-primary: #17191c;
  --text-secondary: #555b64;
  --text-muted: #737b86;
  --border: #dfe2e6;
  --border-strong: #c7cdd4;
  --accent: #3f70dc;
  --accent-contrast: #ffffff;
  --accent-hover: #315fc5;
  --focus-ring: #477ee8;
  --user-message-bg: #e9edf4;
  --assistant-message-bg: transparent;
  --code-bg: #f0f2f5;
  --danger: #c43f4f;
  --success: #21845b;
  --warning: #a96812;
  --shadow-soft: 0 8px 30px rgb(20 25 35 / 8%);
}

:root[data-mode='dark'] {
  color-scheme: dark;
  --app-bg: #212326;
  --sidebar-bg: #181a1d;
  --surface: #26292d;
  --surface-raised: #2d3035;
  --surface-hover: #34383e;
  --surface-selected: #3a3f46;
  --text-primary: #f1f2f3;
  --text-secondary: #c0c5cc;
  --text-muted: #929aa4;
  --border: #3b4047;
  --border-strong: #4c535d;
  --accent: #8aaeff;
  --accent-contrast: #101a2c;
  --accent-hover: #a2bdff;
  --focus-ring: #9bb9ff;
  --user-message-bg: #303844;
  --assistant-message-bg: transparent;
  --code-bg: #17191c;
  --danger: #ff7d89;
  --success: #62c99b;
  --warning: #e8b15d;
  --shadow-soft: 0 12px 36px rgb(0 0 0 / 26%);
}
```

These are starter values, not a mandate to copy them. Validate the actual contrast and tune the neutral surfaces for the brand.

## 2. Separate palette from mode

- `mode`: `light | dark | system` (system resolves through `prefers-color-scheme`).
- `palette`: named accent family such as `graphite | ocean | violet | forest | ember | rose`.
- Store the preference as a versioned object, for example `{ version: 1, mode: 'system', palette: 'ocean' }`.
- `system` should use OS preference for surface tokens while retaining the selected palette accent.
- Apply attributes on the document root only in browser context. SSR should render a stable default and hydrate without markup disagreement.

## 3. Palette presets

Each preset should primarily define `--accent`, `--accent-contrast`, `--accent-hover`, and `--focus-ring`. It may also define a subtle selected-surface tint if contrast remains strong.

```css
:root[data-palette='graphite'] {
  --accent: #697586;
  --accent-contrast: #ffffff;
  --accent-hover: #566273;
  --focus-ring: #8794a7;
}

:root[data-palette='ocean'] {
  --accent: #167e9b;
  --accent-contrast: #ffffff;
  --accent-hover: #116b84;
  --focus-ring: #49b4d1;
}

:root[data-palette='violet'] {
  --accent: #7856c8;
  --accent-contrast: #ffffff;
  --accent-hover: #6644b5;
  --focus-ring: #a98be9;
}

:root[data-palette='forest'] {
  --accent: #267b59;
  --accent-contrast: #ffffff;
  --accent-hover: #1e684b;
  --focus-ring: #62b68c;
}

:root[data-palette='ember'] {
  --accent: #b85a31;
  --accent-contrast: #ffffff;
  --accent-hover: #9c4826;
  --focus-ring: #e28a60;
}

:root[data-palette='rose'] {
  --accent: #b44e79;
  --accent-contrast: #ffffff;
  --accent-hover: #983d65;
  --focus-ring: #dd83a8;
}
```

Check accent contrast against both light and dark surfaces. A single token may need light/dark variants if a palette's chosen hue fails contrast in one mode. Never assume all accent colors work equally well in both.

## 4. Theme service shape

A small service can expose `mode`, `palette`, and a computed resolved mode. Keep persistence separate from the components. Example API, not a mandatory exact implementation:

```ts
export type ThemeMode = 'light' | 'dark' | 'system';
export type ThemePalette = 'graphite' | 'ocean' | 'violet' | 'forest' | 'ember' | 'rose';

export interface ThemePreference {
  version: 1;
  mode: ThemeMode;
  palette: ThemePalette;
}

// ThemeService public surface:
// readonly preference = signal<ThemePreference>(DEFAULT_THEME);
// readonly resolvedMode = computed<'light' | 'dark'>(...);
// setMode(mode: ThemeMode): void;
// setPalette(palette: ThemePalette): void;
// hydrateFromStorage(): void; // call only in a browser-safe lifecycle point
```

Implementation details:

- Validate stored values against allowed enums; ignore malformed or old unsupported values.
- Guard `localStorage` and `matchMedia` with `isPlatformBrowser` or an equivalent abstraction.
- Listen for system theme changes only while mode is `system`, and clean up the listener.
- Set `data-mode` to the resolved light/dark mode and `data-palette` to the selected palette.
- Keep transition behavior short and disable nonessential transitions for `prefers-reduced-motion`.

## 5. Palette picker UX

- Show each palette as a compact preview made from 3–4 real semantic swatches (canvas, surface, accent, text), not a single colored dot.
- Label every swatch/preset; selection state must include an icon/checkmark or border, not color alone.
- Update the whole interface immediately when the user selects a preset.
- Show mode controls separately from palette controls.
- Include a default/reset choice only if it has defined behavior.
