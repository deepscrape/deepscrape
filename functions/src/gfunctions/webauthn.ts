/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
// ponytail: passkey ceremonies now metered per UID. Aliased — no call site changes.
// Each generate*Options call writes a Firestore challenge doc, so this was a cheap
// write-amplification loop for one authenticated account.
import { guardedOnCall as onCall } from "../infrastructure/callable-limiter"
import { Timestamp } from "firebase-admin/firestore"
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server"
import { db, auth as adminAuth } from "../app/config"
import { redis } from "../app/cacheConfig"
import { PASSKEY_CHALLENGE_PREFIX, PASSKEY_CHALLENGE_TTL_SECONDS } from "../../../src/config/redis-keys"
import { env, functionsEnvJson } from "../config/env"
import { validateCallableData } from "../infrastructure/validate"
import { z } from "zod"

// WebAuthn configuration
const RP_NAME = env.RP_NAME || "DeepScrape"
const RP_ORIGIN = env.RP_ORIGIN || "http://localhost:4200"
const RP_ID = new URL(RP_ORIGIN).hostname

// eslint-disable-next-line valid-jsdoc
/**
 * Helper: retrieve stored passkey credentials for a user from Firestore.
 */
/**
 * getPasskeyCredentials
 * @param {*} userId
 */
async function getPasskeyCredentials(userId: string) {
  const snapshot = await db
    .collection("users")
    .doc(userId)
    .collection("passkey_credentials")
    .get()

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
    createdAt: doc.data().createdAt?.toDate?.()?.toISOString?.() || doc.data().createdAt,
  }))
}

/**
 * Read the challenge the browser signed, out of the assertion's client data.
 *
 * An anonymous sign-in cannot be handed a challenge to look up — the caller has not said
 * who they are — so the value travels back inside `clientDataJSON` and the Redis key is
 * derived from it. `verifyAuthenticationResponse` would compare it anyway; reading it here
 * is what lets the right key be found in the first place.
 *
 * @param {string} clientDataJSON Base64url client data from the assertion.
 * @return {string} The challenge the client signed.
 */
const readChallengeFromClientData = (clientDataJSON: string): string => {
  const decoded = JSON.parse(
    Buffer.from(clientDataJSON, "base64url").toString("utf8")
  ) as { challenge?: string }

  if (!decoded.challenge) {
    throw new Error("Malformed WebAuthn client data")
  }

  return decoded.challenge
}

/**
 * Find a stored passkey by its credential id.
 *
 * With an owner this is a subcollection lookup. Without one — a sign-in — the credential id
 * is the only identity the request carries, so it becomes a collection-group query, and the
 * assertion still has to verify against the public key stored under whichever owner it
 * resolves to. That is the whole reason `passkey_credentials` has a collection-group index
 * on `credentialId`.
 *
 * @param {string} userId Owner uid, or an empty string for a sign-in.
 * @param {string} credentialIdB64 Credential id returned by the authenticator.
 * @return {*} The matching credential documents.
 */
const findPasskeyCredential = (userId: string, credentialIdB64: string) => {
  if (userId) {
    return db
      .collection("users")
      .doc(userId)
      .collection("passkey_credentials")
      .where("credentialId", "==", credentialIdB64)
      .get()
  }

  return db
    .collectionGroup("passkey_credentials")
    .where("credentialId", "==", credentialIdB64)
    .limit(1)
    .get()
}

/**
 * Generate WebAuthn registration options (passkey creation ceremony).
 * Client calls this before navigator.credentials.create().
 */
export const generateWebAuthnRegistrationOptions = onCall(
  {
    cors: true,
    secrets: [functionsEnvJson],
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const auth = request.auth
    if (!auth) {
      throw new Error("Unauthorized")
    }

    const userId = auth.uid

    try {
      const userRecord = await adminAuth.getUser(userId)
      const email = userRecord.email || `user-${userId.slice(0, 8)}@deepscrape.dev`
      const displayName = userRecord.displayName || email

      // Get existing credentials IDs to exclude from re-registration
      const existingCreds = await getPasskeyCredentials(userId)
      const excludeCredentials = existingCreds
        .filter((c: any) => c.credentialId)
        .map((c: any) => ({
          id: c.credentialId,
          transports: ["internal" as const],
        }))

      const opts = {
        rpName: RP_NAME,
        rpID: RP_ID,
        userName: email,
        userDisplayName: displayName,
        userID: Buffer.from(userId),
        attestationType: "none" as const,
        excludeCredentials,
        authenticatorSelection: {
          authenticatorAttachment: "platform" as const,
          userVerification: "required" as const,
          residentKey: "required" as const,
        },
      }

      const options = await generateRegistrationOptions(opts)

      // Store the challenge temporarily in Firestore for verification
      await db.collection("users").doc(userId).collection("webauthn_challenges").doc("current").set({
        challenge: options.challenge,
        createdAt: Timestamp.now(),
        type: "registration",
      })

      return { success: true, options }
    } catch (error) {
      console.error("❌ Error generating WebAuthn registration options:", error)
      throw new Error(
        "Failed to generate registration options"
      )
    }
  }
)

/**
 * Verify WebAuthn registration response and store the passkey credential.
 */
export const verifyWebAuthnRegistration = onCall(
  {
    cors: true,
    secrets: [functionsEnvJson],
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const auth = request.auth
    if (!auth) {
      throw new Error("Unauthorized")
    }

    const userId = auth.uid
    const { credential } = validateCallableData(
      z.object({
        credential: z.object({
          id: z.string().min(1).max(1024),
          type: z.string().max(64).optional(),
          rawId: z.string().max(4096).optional(),
          response: z.object({
            clientDataJSON: z.string().min(1).max(16384),
            attestationObject: z.string().min(1).max(16384).optional(),
            transports: z.array(z.string().max(64)).optional(),
            clientExtensionResults: z.record(z.unknown()).default({}),
          }).passthrough(),
        }).passthrough(),
      }),
      request.data
    )

    try {
      // Retrieve the stored challenge
      const challengeDoc = await db
        .collection("users")
        .doc(userId)
        .collection("webauthn_challenges")
        .doc("current")
        .get()

      if (!challengeDoc.exists) {
        throw new Error("No pending registration challenge found. Please start registration again.")
      }

      const challengeData = challengeDoc.data()
      if (!challengeData) {
        throw new Error("No pending registration challenge data found. Please start registration again.")
      }

      const expectedChallenge = challengeData.challenge

      // Clean up the challenge
      await challengeDoc.ref.delete()

      const verification = await verifyRegistrationResponse({
        response: credential as any,
        expectedChallenge,
        expectedOrigin: RP_ORIGIN,
        expectedRPID: RP_ID,
      })

      if (!verification.verified || !verification.registrationInfo) {
        throw new Error("WebAuthn registration verification failed")
      }

      const webauthnCredential = verification.registrationInfo.credential

      // Store the credential in Firestore
      const credentialRef = db
        .collection("users")
        .doc(userId)
        .collection("passkey_credentials")
        .doc()

      const credentialData = {
        credentialId: webauthnCredential.id,
        publicKey: Buffer.from(webauthnCredential.publicKey).toString("base64url"),
        counter: webauthnCredential.counter,
        deviceName: "Passkey",
        transports: webauthnCredential.transports || ["internal"],
        createdAt: Timestamp.now(),
        lastUsedAt: Timestamp.now(),
      }

      await credentialRef.set(credentialData)

      console.log(`✅ Passkey registered for user ${userId}`)

      return {
        success: true,
        credentialId: credentialRef.id,
        credentialName: credentialData.deviceName,
      }
    } catch (error) {
      console.error("❌ Error verifying WebAuthn registration:", error)
      throw new Error(
        "Failed to verify registration"
      )
    }
  }
)

/**
 * Generate WebAuthn authentication options (passkey assertion ceremony).
 * Client calls this before navigator.credentials.get().
 */
export const generateWebAuthnAuthenticationOptions = onCall(
  {
    cors: true,
    secrets: [functionsEnvJson],
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const auth = request.auth
    const userId = auth?.uid

    try {
      // Signed-in caller: this is a step-up, so the credential list is theirs and the
      // challenge lives beside it — one doc per user is bounded.
      if (userId) {
        const existingCreds = await getPasskeyCredentials(userId)

        const allowCredentials = existingCreds
          .filter((c: any) => c.credentialId)
          .map((c: any) => ({
            id: c.credentialId,
            transports: ["internal" as const],
          }))

        const opts = {
          rpID: RP_ID,
          allowCredentials,
          userVerification: "required" as const,
        }

        const options = await generateAuthenticationOptions(opts)

        // Store the challenge temporarily
        await db.collection("users").doc(userId).collection("webauthn_challenges").doc("current").set({
          challenge: options.challenge,
          createdAt: Timestamp.now(),
          type: "authentication",
        })

        return { success: true, options }
      }

      // Signed-out caller: a sign-in. Nothing identifies the user yet, so allowCredentials
      // stays empty and the authenticator picks a discoverable credential, and the
      // challenge goes to Redis because it has to expire on its own.
      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        allowCredentials: [],
        userVerification: "required" as const,
      })

      await redis.setex(
        `${PASSKEY_CHALLENGE_PREFIX}${options.challenge}`,
        PASSKEY_CHALLENGE_TTL_SECONDS,
        JSON.stringify({ createdAt: new Date().toISOString() }),
      )

      return { success: true, options }
    } catch (error) {
      console.error("❌ Error generating WebAuthn authentication options:", error)
      throw new Error(
        "Failed to generate authentication options"
      )
    }
  }
)

/**
 * Verify WebAuthn authentication response.
 */
export const verifyWebAuthnAuthentication = onCall(
  {
    cors: true,
    secrets: [functionsEnvJson],
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const auth = request.auth
    const userId = auth?.uid
    const { credential } = validateCallableData(
      z.object({
        credential: z.object({
          id: z.string().min(1).max(1024),
          type: z.string().max(64).optional(),
          rawId: z.string().max(4096).optional(),
          response: z.object({
            clientDataJSON: z.string().min(1).max(16384),
            authenticatorData: z.string().min(1).max(8192).optional(),
            signature: z.string().min(1).max(8192).optional(),
            userHandle: z.string().max(512).optional(),
            clientExtensionResults: z.record(z.unknown()).default({}),
          }).passthrough(),
        }).passthrough(),
      }),
      request.data
    )

    try {
      // Either way the challenge is one we issued, and consuming it is what keeps the
      // ceremony single-use: the doc is deleted, the Redis key is read and dropped.
      let expectedChallenge: string
      if (userId) {
        const challengeDoc = await db
          .collection("users")
          .doc(userId)
          .collection("webauthn_challenges")
          .doc("current")
          .get()

        if (!challengeDoc.exists) {
          throw new Error("No pending authentication challenge found")
        }

        expectedChallenge = challengeDoc.data()!.challenge
        await challengeDoc.ref.delete()
      } else {
        expectedChallenge = readChallengeFromClientData(credential.response.clientDataJSON)
        const challengeKey = `${PASSKEY_CHALLENGE_PREFIX}${expectedChallenge}`
        const pending = await redis.get(challengeKey)
        if (!pending) {
          throw new Error("Passkey challenge not found or already used. Please try again.")
        }
        await redis.del(challengeKey)
      }

      // Find the stored credential by the credential ID sent back from the client
      const credentialIdRaw = credential.rawId || credential.id
      const credentialIdB64 = Buffer.from(
        typeof credentialIdRaw === "string" ? credentialIdRaw : new Uint8Array(credentialIdRaw)
      ).toString("base64url")

      // A step-up is scoped to the caller; a sign-in has no caller at all, so the lookup
      // widens to the whole collection group (see findPasskeyCredential).
      const credSnapshot = await findPasskeyCredential(userId || "", credentialIdB64)

      if (credSnapshot.empty) {
        throw new Error("Passkey credential not found. It may have been removed.")
      }

      const credDoc = credSnapshot.docs[0]
      const storedCred = credDoc.data() as any
      const ownerUserId = userId || credDoc.ref.parent.parent?.id || ""

      if (!ownerUserId) {
        throw new Error("Passkey credential is not owned by a user")
      }

      const verification = await verifyAuthenticationResponse({
        response: credential as any,
        expectedChallenge,
        expectedOrigin: RP_ORIGIN,
        expectedRPID: RP_ID,
        credential: {
          id: credentialIdB64,
          publicKey: new Uint8Array(Buffer.from(storedCred.publicKey, "base64url")),
          counter: storedCred.counter,
          transports: storedCred.transports || ["internal"],
        },
      })

      if (!verification.verified) {
        throw new Error("WebAuthn authentication verification failed")
      }

      // Update counter and last used
      await credDoc.ref.update({
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: Timestamp.now(),
      })

      // A passkey is not a Firebase provider, so a sign-in has to be exchanged for a custom
      // token. This deliberately raises no second-factor prompt: Google's own documentation
      // says "your passkey bypasses the second authentication step, since this verifies that
      // you own the device", and userVerification is "required" here — the credential
      // already proves possession plus a device unlock.
      const customToken = userId ? "" : await adminAuth.createCustomToken(ownerUserId)

      console.log(`✅ Passkey authentication verified for user ${ownerUserId}`)

      return {
        success: true,
        credentialId: credDoc.id,
        newCounter: verification.authenticationInfo.newCounter,
        customToken,
      }
    } catch (error) {
      console.error("❌ Error verifying WebAuthn authentication:", error)
      throw new Error(
        "Failed to verify authentication"
      )
    }
  }
)

/**
 * List all passkey credentials for the current user.
 */
export const getWebAuthnCredentials = onCall(
  {
    cors: true,
    enforceAppCheck: false,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const auth = request.auth
    if (!auth) {
      throw new Error("Unauthorized")
    }

    try {
      const credentials = await getPasskeyCredentials(auth.uid)
      return { success: true, credentials }
    } catch (error) {
      console.error("❌ Error getting WebAuthn credentials:", error)
      throw new Error(
        "Failed to get credentials"
      )
    }
  }
)

/**
 * Remove a passkey credential by its Firestore document ID.
 */
export const removeWebAuthnCredential = onCall(
  {
    cors: true,
    enforceAppCheck: false,
    region: "us-central1",
  },
  /**
   * callback
   * @param {*} request
   */
  async (request) => {
    const auth = request.auth
    if (!auth) {
      throw new Error("Unauthorized")
    }

    const { credentialDocId } = validateCallableData(
      z.object({ credentialDocId: z.string().min(1).max(256) }),
      request.data
    )
    if (!credentialDocId) {
      throw new Error("Missing required field: credentialDocId")
    }

    try {
      await db
        .collection("users")
        .doc(auth.uid)
        .collection("passkey_credentials")
        .doc(credentialDocId)
        .delete()

      console.log(`✅ Passkey credential ${credentialDocId} removed for user ${auth.uid}`)

      return { success: true }
    } catch (error) {
      console.error("❌ Error removing WebAuthn credential:", error)
      throw new Error(
        "Failed to remove credential"
      )
    }
  }
)
