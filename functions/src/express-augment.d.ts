import type {DecodedIdToken} from "firebase-admin/auth"

declare module "express-serve-static-core" {
  interface Request {
    user?: DecodedIdToken
    /**
     * The RAW caller token for THIS request, when one was presented.
     *
     * It exists because two proxies must relay the credential verbatim and
     * cannot re-sign it: `handlers/machines.ts` forwards it to Arachnefly,
     * which
     * re-verifies it with Firebase Admin, and `handlers/home_handler.ts`
     * (`heartbeat`) used it as an identity fallback.
     *
     * It must NEVER be stored on `req.app.locals`. That object belongs to the
     * Express APPLICATION, not the request: it is created once per process and
     * shared by every concurrent request, so writing a credential there let one
     * request read another's token. `isJwtAuth` (infrastructure/syncaiapi.ts)
     * and
     * `optionalJwtAuth` (infrastructure/events.ts) are the only writers.
     */
    authToken?: string
    /**
     * The access mode `requirePaidAccess` resolved for this request
     * (`"free" | "credits" | "plan" | …`, or `"admin"` for the platform
     * bypass).
     *
     * Stashed so later middleware reads the SAME entitlement decision instead
     * of
     * re-reading `users/{uid}/billing/current` and possibly disagreeing with it
     * —
     * one read, one decision, shared.
     */
    accessMode?: string
    rateLimit?: {
      resetTime?: number | Date
    }
  }
}

export {}
