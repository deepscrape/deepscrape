/**
 * The localStorage key the theme toggle writes.
 *
 * Kept out of `theme-picker.component.ts` on purpose: a component that imported
 * this constant also imported the component, which pulled the theme picker and
 * its Material dependencies into every lazily-loaded bundle that needed only a
 * string. Import the key from here instead.
 */
export const themeStorageKey = 'app-theme-dark'

/**
 * Resolves dark mode from the user's stored choice, falling back to the OS
 * preference.
 *
 * One implementation on purpose. Ten components carried their own copy and they
 * had already drifted: the profile page's variant returned `false` for a user
 * who never toggled the theme, ignoring a dark OS preference.
 *
 * `storage` and `win` are passed in rather than read off globals so this stays
 * SSR-safe and the callers' injected tokens are what get used.
 */
export function isDarkTheme(
  storage: Storage | null | undefined,
  win: Window | null | undefined
): boolean {
  const stored = storage?.getItem(themeStorageKey)
  if (stored === 'true') return true
  if (stored === 'false') return false
  return win?.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false
}
