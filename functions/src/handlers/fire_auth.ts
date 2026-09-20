/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/* eslint-disable indent */
/* eslint-disable new-cap */
/* eslint-disable @typescript-eslint/no-empty-function */
import { auth, db } from "../app/config"
import { Request, Response } from "express"
import { authErrorCode as getErrorCode } from "../infrastructure/auth-error"


// test email before checking providers with pattern
// eslint-disable-next-line max-len
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
const PHONE_E164_REGEX = /^\+[1-9]\d{6,14}$/

const mergeCustomClaims = async (
    uid: string,
    claims: Record<string, unknown>
) => {
    const userRecord = await auth.getUser(uid)
    const existingClaims = userRecord.customClaims || {}

    await auth.setCustomUserClaims(uid, {
        ...existingClaims,
        ...claims,
    })
}

const getErrorMessage = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message
    }

    if (typeof error === "object" && error !== null && "message" in error) {
        return String((error as { message: unknown }).message)
    }

    return "Unknown error"
}

export const checkUserEmailExistance = async (req: Request, res: Response) => {
    const { email } = req.params as { email: string }
    try {
        // test email before checking providers with pattern
        // eslint-disable-next-line max-len
        if (!email || !EMAIL_REGEX.test(email)) {
            return res.status(400).send({ error: "Invalid email format" })
        }

        // Check if the user exists by email
        const userRecord = await auth.getUserByEmail(email)
        const providers = userRecord.providerData
            .map((provider) => provider.providerId)
        if (providers.length > 1) {
            return res.status(200).send({
                emailExists: true,
                providers: providers,
                hasMultipleProviders: true,
            })
        } else {
            return res.status(200).send({
                emailExists: true,
                providers: providers,
                hasMultipleProviders: false,
            })
        }
    } catch (error: unknown) {
        if (getErrorCode(error) === "auth/user-not-found") {
            return res.status(200).send({ emailExists: false })
        }
        console.error("Error checking user email existence:", error)
        return res.status(500).send({ error: "Internal Server Error" })
    }
}

export const checkUserEmailForDifferentProvider =
    async (req: Request, res: Response) => {
        const { email: encodedEmail } = req.params as { email: string }
        res.type("json")

        // ponytail: this decode sat outside the try, so `GET /oauth/provider/email/%25E0`
        // threw URIError as an unhandled rejection. Express 4 never routes those, so
        // the request hung to the function timeout — remotely, with no credentials
        // (this route is mounted without isJwtAuth). Decode inside the guard.
        let email = ""
        try {
            email = decodeURIComponent(encodedEmail)
        } catch {
            return res.status(400).send({ error: "Invalid email format",
                message: "Please provide a valid email address." })
        }

        try {
            // eslint-disable-next-line max-len
            if (!email || !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) {
                return res.status(400).send({ error: "Invalid email format",
                    message: "Please provide a valid email address." })
            }
            const userRecord = await auth.getUserByEmail(email)
            const providers = userRecord.providerData
                .map((provider) => provider.providerId)


            if (providers.length > 1) {
                return res.status(200).send({
                    exists: true,
                    providers: providers,
                    hasMultipleProviders: true,
                })
            } else {
                return res.status(200).send({
                    exists: true,
                    providers: providers,
                    hasMultipleProviders: false,
                })
            }
        } catch (error: unknown) {
            if (getErrorCode(error) === "auth/user-not-found") {
                return res.status(200).send({ exists: false })
            }
            console.error(
                "Error checking user email for different provider:",
                error,
            )
            // ponytail: `message: getErrorMessage(error)` removed. This route is
            // public (/oauth, no isJwtAuth), and the helper is a raw error.message
            // passthrough — FirebaseAuthError internals reached unauthenticated
            // callers. The logger above already keeps the detail.
            return res.status(500).send({ error: "Internal Server Error" })
        }
    }

export const updateEmailVerificationStatus = async (
    req: Request,
    res: Response,
) => {
    res.type("application/json")
    const { uid } = req.body as { uid: string }

    try {
        if (!uid) {
            return res.status(400).send({
                error: "Missing required fields",
                message: "uid is required",
            })
        }

        const userRecord = await auth.getUser(uid)
        const emailVerified = userRecord.emailVerified === true

        if (!emailVerified) {
            return res.status(409).send({
                error: "Email not verified",
                message: "Firebase Auth does not yet report this email as verified.",
            })
        }

        await mergeCustomClaims(uid, { email_verified: true })
        await db.collection("users").doc(uid).set({
            emailVerified: true,
            updated_At: new Date(),
        }, { merge: true })

        return res.status(200).send({
            success: true,
            emailVerified: true,
            message: "Email verification status synced successfully",
        })
    } catch (error: unknown) {
        console.error("Error updating email verification status:", error)

        return res.status(500).send({
            error: "Internal Server Error",
            message: getErrorMessage(error),
        })
    }
}
export const verifyLogin = async (req: Request, res: Response) => {
    const { idToken, providerId } = req.body

    if (!idToken || !providerId) {
        return res.status(400).send({ error: "Missing idToken or providerId" })
    }

    try {
        const decodedToken = await auth.verifyIdToken(idToken, true)
        let { email, uid: newUid } = decodedToken

        if (!email) {
            // return res.status(400)
            // .send({ error: "Email not found in ID token" })
            console.warn("Email not provided in request body," +
                " using decoded token email")
            const newUser = await auth.getUser(newUid)
            email = newUser.email || ""
            if (!email) {
                console.error("Email not found in decoded token or user record")
                return res.status(400)
                .send({ error: "Email not found in New User" })
            }
        }

        let existingUserRecord
        try {
            existingUserRecord = await auth.getUserByEmail(email)
        } catch (error: unknown) {
            if (getErrorCode(error) === "auth/user-not-found") {
                 // No existing user → keep this new provider account
                // Case 1: No user exists with this email. This is a new signup.
                // Firebase automatically creates a user
                // when signInWithPopup is used.
                // The decodedToken.uid is the UID of this newly created user.
                // We just need to confirm it's
                // not a duplicate and return success.
                // message: "No existing account, signup success"
                return res.status(200)
                .send({ mergeRequired: false })
            }
            throw error // Re-throw other errors
        }

        // If we reach here, an existing user with the same email was found.
        if (existingUserRecord.uid === newUid) {
            // Already unified
            // Case 2: User exists with the same UID. Normal login.
            // message: "User already linked"
            return res.status(200)
                .send({ mergeRequired: false })
        } else {
            // Case 3: User exists with a different UID but same email.
            //  Merge required.
            // Delete the newly created user
            // (decodedToken.uid) to avoid orphaned accounts.
            await auth.deleteUser(newUid)
            // message: "Account exists, please link new provider",
            return res.status(200)
            .send({ mergeRequired: true, existingUid: existingUserRecord.uid })
        }
    } catch (error: unknown) {
        if (getErrorCode(error) === "auth/id-token-revoked") {
            return res.status(401)
            .send({ error: "Unauthorized", code: "session_revoked", message: "Session revoked. Please sign in again." })
        }

        if (getErrorCode(error) === "auth/argument-error" || getErrorCode(error) === "auth/invalid-id-token") {
            return res.status(401)
            .send({ error: "Unauthorized", code: "invalid_token", message: "Invalid authentication token." })
        }

        console.error("Error in verifyLogin, Merge provider error:", error)
        return res.status(500)
        .send({ error: "Internal Server Error", message: getErrorMessage(error) })
    }
}

// Allowed characters for usernames to prevent injection via Firestore queries
const USERNAME_REGEX = /^[a-zA-Z0-9._-]{2,64}$/

/**
 * POST /oauth/resolve-identifier
 * Resolves a username or E.164 phone number to the account email.
 * Used by the login flow for non-email identifiers.WS
 *
 * Body: { username?: string } | { phone?: string }
 * Response 200: { email: string }
 * Response 400: invalid input
 * Response 404: user not found
 * @param {*} req
 * @param {*} res
 */
export const resolveIdentifier = async (req: Request, res: Response) => {
    res.type("application/json")

    const usernameRaw: unknown = req.body?.username
    const phoneRaw: unknown = req.body?.phone

    const hasUsername = typeof usernameRaw === "string" && usernameRaw.trim().length > 0
    const hasPhone = typeof phoneRaw === "string" && phoneRaw.trim().length > 0

    if (!hasUsername && !hasPhone) {
        return res.status(400).json({
            error: "invalid-argument",
            message: "Provide either 'username' or 'phone' in the request body.",
        })
    }

    try {
        if (hasPhone) {
            const phone = (phoneRaw as string).trim()

            if (!PHONE_E164_REGEX.test(phone)) {
                return res.status(400).json({
                    error: "invalid-argument",
                    message: "Phone must be a valid E.164 number (e.g. +15551234567).",
                })
            }

            // Firebase Auth can look up users directly by phone number
            const userRecord = await auth.getUserByPhoneNumber(phone)
            if (!userRecord.email) {
                return res.status(404).json({
                    error: "not-found",
                    message: "No email associated with this phone number.",
                })
            }

            return res.status(200).json({ email: userRecord.email })
        }

        // Username path — query Firestore users collection
        const username = (usernameRaw as string).trim().toLowerCase()

        if (!USERNAME_REGEX.test(username)) {
            return res.status(400).json({
                error: "invalid-argument",
                message: "Username contains invalid characters.",
            })
        }

        const snapshot = await db.collection("users")
            .where("username", "==", username)
            .limit(1)
            .get()

        if (snapshot.empty) {
            return res.status(404).json({
                error: "not-found",
                message: "No account found for this username.",
            })
        }

        const userData = snapshot.docs[0].data()
        const email: string | undefined = userData?.email

        if (!email || typeof email !== "string") {
            return res.status(404).json({
                error: "not-found",
                message: "No email associated with this username.",
            })
        }

        return res.status(200).json({ email })
    } catch (error: unknown) {
        if (getErrorCode(error) === "auth/user-not-found") {
            return res.status(404).json({
                error: "not-found",
                message: "No account found for this phone number.",
            })
        }
        console.error("resolveIdentifier error:", error)
        return res.status(500).json({ error: "Internal Server Error" })
    }
}

