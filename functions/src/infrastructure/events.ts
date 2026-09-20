/* eslint-disable object-curly-spacing */
/* eslint-disable indent */
/* eslint-disable new-cap */
/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable max-len */
import { NextFunction, Request, Response, Router } from "express"
import { DecodedIdToken } from "firebase-admin/lib/auth/token-verifier"
import { analyticsEventHandler, batchAnalyticsEventHandler, guestFingerprintHandler } from "../gfunctions"
import { heartbeat } from "../handlers"
import { auth as adminAuth } from "../app/config"

declare module "express-serve-static-core" {
    interface Request {
        user?: DecodedIdToken
    }
}

/**
 * EventsAPIProxy
 */
class EventsAPIProxy {
    public router: Router

    /**
     * callback
     */
    constructor() {
        this.router = Router()
        this.httpRoutesGets()
        this.httpRoutesPosts()
        this.httpRoutesPut()
        this.httpRoutesDelete()
    }

    // ------------------- Node JS Security -------------------

    /**
     * Optional bearer auth for the /event routes.
     *
     * ponytail: the Angular client ALREADY sends `Authorization: Bearer <token>`
     * on /event/heartbeat (HeartbeatService.buildHeaders), but this router had no
     * auth middleware at all — so the token was sent and silently ignored, and
     * `heartbeat` fell back to reading `userId` out of the client-written `aid`
     * cookie. Guests must keep working and they send `Bearer ` with an empty
     * token, so a missing or unverifiable token means "anonymous", never 401.
     * A present-and-valid token populates req.user, which heartbeat now requires
     * before it will honour a claimed userId.
     */
    /**
     * optionalJwtAuth
     * @param {*} req
     * @param {*} res
     * @param {*} next
     */
    private async optionalJwtAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
        const authHeader = (req.headers["authorization"] as string) || ""
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : ""

        if (token) {
            try {
                req.user = await adminAuth.verifyIdToken(token, true)
            } catch (error) {
                // Expired / revoked / malformed: stay anonymous. A 401 here would break
                // the guest heartbeat, which has no token to offer.
                console.warn("events: token verification failed, continuing anonymously:", error)
            }
        }

        next()
    }

    // ------------------- Node JS Routes -------------------

    /**
     * https Router Gets
     */

    /**
     * httpRoutesGets
     */
    private httpRoutesGets(): void {

    }

    /**
     * https Router Post
     */

    /**
     * httpRoutesPosts
     */
    private httpRoutesPosts(): void {
        // this.router.post('/api/machines/logs', receiveLogs)

        /* Heartbeats and Analytics */
        // Guest fingerprint endpoint
        this.router.post("/guest-fingerprint", guestFingerprintHandler)


        // Analytics event endpoint
        this.router.post("/analytics/event", analyticsEventHandler)

        // Analytics batch event endpoint
        this.router.post("/analytics/batch", batchAnalyticsEventHandler)

        // Heartbeat endpoint for guests and users
        // ponytail: optionalJwtAuth must stay first — heartbeat derives identity from
        // req.user and will not honour a cookie-claimed userId without it.
        this.router.post("/heartbeat", this.optionalJwtAuth, heartbeat)
    }
    /**
           * https Router Put
           */

    /**
     * httpRoutesPut
     */
    private httpRoutesPut(): void {


        /**
         * Crawler Management by crawlagent
        */

        // Cancel a Crawl Task
        // this.router.put("/crawl/job/:tempTaskId/cancel", crawlagent.cancelTask)
    }

    /**
     * https Router Delete
     */

    /**
     * httpRoutesDelete
     */
    private httpRoutesDelete(): void {
        /**
         * Machines by Arachnefly
         */

    }
}

// ---- Helpers (enumeration-safe) ----
// async function getOrCreateUserByEmail(email: string, profile = {}) {
//   try {
//     const user = await auth.getUserByEmail(email)
//     return user; // Do not reveal to client
//   } catch (e: any) {
//     if (e.code === "auth/user-not-found") {
//       // Create without revealing existence
//       return await auth.createUser({
//         email,
//         emailVerified: !!profile.emailVerified,
//         displayName: profile.displayName || undefined,
//         photoURL: profile.picture || undefined,
//       })
//     }
//     throw e
//   }
// }

export { EventsAPIProxy }
