/**
 * The machine API base, which is the BFF in EVERY environment.
 *
 * It used to be `/machines` in development, served by a `proxy.conf.json` entry
 * that rewrote it to `/api/machines` on the same local port. That entry was
 * redundant -- `/api` already proxies to the same target, so the rewrite produced
 * the identical request -- and it claimed the `/machines` PREFIX, which meant a
 * direct navigation to `/machines` was proxied to the API instead of serving the
 * Angular app. `/machines` is now a real page, so the prefix has to be free.
 *
 * Production and emulators already used `/api/machines`, so this removes a
 * development-only divergence rather than introducing one.
 */
export const API_ARACHNEFLY_URL = '/api/machines'