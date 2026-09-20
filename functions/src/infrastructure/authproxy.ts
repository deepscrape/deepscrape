/* eslint-disable object-curly-spacing */
/* eslint-disable indent */
/* eslint-disable new-cap */
/* eslint-disable @typescript-eslint/no-empty-function */

import { NextFunction, Request, Response, Router } from "express"
import { auth } from "../app/config"
import { upstashAuthLimiter } from "../handlers/upstash-limiter"
import {
    checkUserEmailForDifferentProvider,
    updateEmailVerificationStatus,
    verifyLogin,
    verifyPhoneNumber,
    linkPhoneToAccount,
    updatePhoneVerificationStatus,
    checkPhoneNumberExists,
    resolveIdentifier,
} from "../handlers"
import { authErrorCode as getAuthErrorCode } from "./auth-error"

/* eslint-disable max-len */
/**
 * AuthAPIProxy
 */
class AuthAPIProxy {
    public router: Router

    /**
     * callback
     */
    constructor() {
        this.router = Router()
        this.httpRoutesGets()
        this.httpRoutesPosts()
        // this.httpRoutesPut()
        // this.httpRoutesDelete()
    }

    /**
     * isJwtAuth
     * @param {*} req
     * @param {*} res
     * @param {*} next
     */
    private async isJwtAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
        const authHeader = req.headers["authorization"] as string

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            res.status(401).json({ error: "Unauthorized: Missing or invalid token" })
            return
        }

        const token = authHeader.split(" ")[1]

        try {
            const decodedToken = await auth.verifyIdToken(token, true)
            req.user = decodedToken
            next()
        } catch (error) {
            console.error("JWT Verification Error:", error)
            const code = getAuthErrorCode(error)
            if (code === "auth/id-token-revoked") {
                res.status(401).json({ error: "Unauthorized: Session revoked", code: "session_revoked" })
                return
            }

            res.status(401).json({ error: "Unauthorized: Invalid token", code: "invalid_token" })
        }
    }

    /**
     * requireSelfOrAdmin
     * @param {*} req
     * @param {*} res
     * @param {*} next
     */
    private requireSelfOrAdmin(req: Request, res: Response, next: NextFunction): void {
        const targetUid = req.body?.uid as string | undefined
        const callerUid = req.user?.uid
        const callerRole = (req.user as Record<string, unknown> | undefined)?.["role"]

        if (!targetUid || typeof targetUid !== "string") {
            res.status(400).json({ error: "Missing required fields", message: "uid is required" })
            return
        }

        if (!callerUid) {
            res.status(401).json({ error: "Unauthorized: Missing user context" })
            return
        }

        if (callerUid === targetUid || callerRole === "admin") {
            next()
            return
        }

        res.status(403).json({ error: "Forbidden", message: "Insufficient permissions" })
    }

    /**
     * httpRoutesGets
     */
    private httpRoutesGets(): void {
        // Check if user email exists and which provider is used
        this.router.get("/provider/email/:email", checkUserEmailForDifferentProvider)
    }

    /**
     * httpRoutesPosts
     */
    private httpRoutesPosts(): void {
        // Resolve a username or phone number to the account email
        this.router.post("/resolve-identifier", upstashAuthLimiter, resolveIdentifier)

        // Check if phone number exists (moved from GET to POST for security)
        this.router.post("/provider/phone/check", upstashAuthLimiter, checkPhoneNumberExists)

        // Verify and link provider
        // This is used to link a new provider to an existing user account
        this.router.post("/verify-login", upstashAuthLimiter, verifyLogin)

        // Email verification
        this.router.post("/email/verification", this.isJwtAuth, this.requireSelfOrAdmin, updateEmailVerificationStatus)

        // Phone verification endpoints
        this.router.post("/phone/verify", upstashAuthLimiter, verifyPhoneNumber)
        this.router.post("/phone/link", this.isJwtAuth, linkPhoneToAccount)
        this.router.post("/phone/update-verification", this.isJwtAuth, this.requireSelfOrAdmin, updatePhoneVerificationStatus)
    }
}

export { AuthAPIProxy }
