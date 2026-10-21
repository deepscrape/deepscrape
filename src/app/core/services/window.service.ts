import { InjectionToken } from '@angular/core';

export const WindowToken = new InjectionToken<Window>('Window');

function getWindow(): any {
  return window;
}

/**
 * The server-side stand-in for `window`.
 *
 * `new Window()` could never work: `Window` is a DOM global, so under Node it is a
 * plain `ReferenceError` thrown during DI resolution — which is what an SSR request
 * got instead of a page. (The original even asked "does this work?" in a comment; it
 * does not.)
 *
 * A Proxy rather than a hand-written object, because the failure mode of a partial
 * stub is a TypeError at some unpredictable call site. Anything not listed resolves
 * to a no-op, so a new `window.x` usage degrades to doing nothing instead of taking
 * down prerendering.
 * @return {Window} A headless stub.
 */
function ssrWindowStub(): Window {
  const noop = () => undefined;

  /**
   * A real Storage, because `storage.service.ts`'s `getStorage` does
   * `win['localStorage']` inside a try/catch and returns WHATEVER it gets. Handing
   * back a generic no-op function made that call return a function — truthy, so a
   * caller's `this.localStorage?.getItem(...)` did not short-circuit and threw
   * "getItem is not a function" in every prerendered route.
   */
  const storage = () => ({
    length: 0,
    clear: noop,
    getItem: () => null,
    key: () => null,
    removeItem: noop,
    setItem: noop,
  });

  const target = {
    document: {
      hidden: true,
      visibilityState: 'hidden',
      cookie: '',
      addEventListener: noop,
      removeEventListener: noop,
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({ getContext: () => null }),
    },
    navigator: { userAgent: 'SSR', onLine: false },
    location: { href: 'http://localhost/', pathname: '/', search: '' },
    localStorage: storage(),
    sessionStorage: storage(),
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({
      matches: false,
      addEventListener: noop,
      removeEventListener: noop,
    }),
    innerWidth: 0,
    innerHeight: 0,
  };

  // Unknown keys answer `undefined`, NOT a no-op function. A function is truthy,
  // so it defeats every `?.` guard the callers rely on — which is exactly how the
  // first version of this stub turned one missing property into a failed prerender
  // of all 14 routes.
  return new Proxy(target, {
    get: (obj, key) =>
      key in obj ? (obj as Record<string | symbol, unknown>)[key] : undefined,
  }) as unknown as Window;
}

function nativeWindow(): Window {

  if (typeof window !== 'undefined') {
    return getWindow()
  }

  return ssrWindowStub();

}

export function windowProvider() { return nativeWindow(); }