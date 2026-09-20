/* eslint-disable object-curly-spacing */
/* eslint-disable indent */
/* eslint-disable new-cap */
/* eslint-disable @typescript-eslint/no-empty-function */

import { Request, Response } from "express"
import { auth, db } from "../app/config"
import { authErrorCode as getErrorCode } from "../infrastructure/auth-error"

// Phone number validation regex (E.164 format)
const PHONE_REGEX = /^\+[1-9]\d{1,14}$/

// ponytail: getErrorMessage() deleted. Its only consumers were the 500 handlers
// below, which leaked raw error.message to unauthenticated callers.

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

export const verifyPhoneNumber = async (req: Request, res: Response) => {
    const { phoneNumber } = req.body as { phoneNumber: string }

    try {
        // Validate phone number format
        if (!phoneNumber || !PHONE_REGEX.test(phoneNumber)) {
            return res.status(400).send({
                error: "Invalid phone number format",
                message:
                    "Phone number must be in E.164 format " +
                    "(e.g., +1234567890)",
            })
        }

        // Check if phone number is already in use
        try {
            await auth.getUserByPhoneNumber(phoneNumber)
            return res.status(409).send({
                error: "Phone number already exists",
                message:
                    "This phone number is already associated with another " +
                    "account",
            })
        } catch (error: unknown) {
            // If user not found, that's good - we can proceed
            if (getErrorCode(error) !== "auth/user-not-found") {
                throw error
            }
        }

        return res.status(200).send({
            available: true,
            message: "Phone number is available",
        })
    } catch (error: unknown) {
        console.error("Error verifying phone number:", error)
        return res.status(500).send({
            error: "Internal Server Error",
        })
    }
}

export const linkPhoneToAccount = async (req: Request, res: Response) => {
    const { phoneNumber } = req.body as { phoneNumber: string }
    const uid = req.user?.uid

    try {
        if (!uid || !phoneNumber) {
            return res.status(400).send({
                error: "Missing required fields",
                message: "Authenticated user and phoneNumber are required",
            })
        }

        // Validate phone number format
        if (!PHONE_REGEX.test(phoneNumber)) {
            return res.status(400).send({
                error: "Invalid phone number format",
                message: "Phone number must be in E.164 format",
            })
        }

        // Check if phone number is already in use by another user
        try {
            const existingUser = await auth.getUserByPhoneNumber(phoneNumber)
            if (existingUser.uid !== uid) {
                return res.status(409).send({
                    error: "Phone number already in use",
                    message:
                        "This phone number is already associated with" +
                        " another account",
                })
            }
        } catch (error: unknown) {
            // If user not found, that's fine - we can link it
            if (getErrorCode(error) !== "auth/user-not-found") {
                throw error
            }
        }

        // Update user with phone number
        await auth.updateUser(uid, {
            phoneNumber,
        })

        return res.status(200).send({
            success: true,
            message: "Phone number linked successfully",
        })
    } catch (error: unknown) {
        console.error("Error linking phone to account:", error)
        return res.status(500).send({
            error: "Internal Server Error",
        })
    }
}

export const updatePhoneVerificationStatus = async (
    req: Request,
    res: Response
) => {
    const { uid, phoneNumber } = req.body as {
        uid: string,
        phoneNumber?: string,
    }

    try {
        if (!uid) {
            return res.status(400).send({
                error: "Missing required fields",
                message: "uid is required",
            })
        }

        const userRecord = await auth.getUser(uid)
        const enrolledFactors = userRecord.multiFactor?.enrolledFactors || []
        const enrolledPhoneFactor = enrolledFactors.find(
            (factor) => factor.factorId === "phone",
        )
        const enrolledPhoneNumber = (() => {
            if (!enrolledPhoneFactor) {
                return null
            }

            const phoneFactor =
                enrolledPhoneFactor as unknown as Record<string, unknown>
            const rawPhone = phoneFactor[
                "phoneNumber"
            ]

            if (typeof rawPhone === "string" && rawPhone.length > 0) {
                return rawPhone
            }

            return null
        })()

        const resolvedPhoneNumber =
            userRecord.phoneNumber ||
            enrolledPhoneNumber ||
            (typeof phoneNumber === "string" && phoneNumber.length > 0 ?
                phoneNumber :
                null)

        const phoneVerified = !!resolvedPhoneNumber

        await mergeCustomClaims(uid, { phoneVerified })
        await db.collection("users").doc(uid).set({
            phoneNumber: resolvedPhoneNumber,
            phoneVerified,
            updated_At: new Date(),
        }, { merge: true })

        return res.status(200).send({
            success: true,
            phoneVerified,
            message: "Phone verification status synced successfully",
        })
    } catch (error: unknown) {
        console.error("Error updating phone verification status:", error)
        return res.status(500).send({
            error: "Internal Server Error",
        })
    }
}

export const checkPhoneNumberExists = async (req: Request, res: Response) => {
    res.type("application/json")
    const { phoneNumber } = req.body as { phoneNumber: string }

    try {
        if (!phoneNumber || !PHONE_REGEX.test(phoneNumber)) {
            return res.status(400).send({
                error: "Invalid phone number format",
                message: "Phone number must be in E.164 format",
            })
        }

        try {
            await auth.getUserByPhoneNumber(phoneNumber)
            return res.status(200).send({
                exists: true,
            })
        } catch (error: unknown) {
            if (getErrorCode(error) === "auth/user-not-found") {
                return res.status(200).send({ exists: false })
            }
            throw error
        }
    } catch (error: unknown) {
        console.error("Error checking phone number existence:", error)
        // ponytail: `message: getErrorMessage(error)` removed. This route is
        // public (/oauth/provider/phone/check), and the helper is a raw
        // error.message passthrough — FirebaseAuthError internals reached
        // unauthenticated callers. The distinction that the login UX needs
        // (auth/user-not-found) is handled in the 200 branches above.
        return res.status(500).send({
            error: "Internal Server Error",
        })
    }
}
