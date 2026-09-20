import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
} from 'firebase-admin/app'
import { getAuth, type Auth } from 'firebase-admin/auth'

/**
 * Bun-safe Firebase Admin bootstrap.
 *
 * Why this exists instead of importing `functions/src/app/config.ts`: that module
 * builds the admin config at IMPORT time and reaches for `__dirname` inside
 * `resolveLocalServiceAccount()`. Under Bun ESM `__dirname` is undefined, so
 * `path.resolve(undefined, ...)` throws before anything runs. It also calls
 * `defineSecret`/`defineJsonSecret` (firebase-functions/params) and constructs a
 * `SecretManagerServiceClient` at module scope — all of it pointless here,
 * because on Cloud Run the credentials come from the runtime service account and
 * the config comes from plain environment variables.
 *
 * Nothing below runs at import time. That is the whole point.
 */

const DB_NAME = (process.env['DB_NAME'] || '').trim() || 'easyscrape'

let app: App | undefined
let auth: Auth | undefined

export const adminApp = (): App => {
  if (app) {
    return app
  }

  if (getApps().length) {
    app = getApps()[0]!
    return app
  }

  // ponytail: ADC by default (no long-lived key on Cloud Run); the explicit key
  // stays supported so a non-GCP host or the emulator can still run this. Never
  // log the value.
  const key = process.env['FIRE_SERVICE_ACCOUNT_KEY']

  app = initializeApp(
    key
      ? { credential: cert(JSON.parse(key) as Parameters<typeof cert>[0]) }
      : { credential: applicationDefault() },
  )

  return app
}

export const adminAuth = (): Auth => (auth ??= getAuth(adminApp()))

export { DB_NAME }
