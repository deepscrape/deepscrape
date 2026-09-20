/* eslint-disable indent */
/* eslint-disable object-curly-spacing */
/* eslint-disable linebreak-style */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as admin from "firebase-admin"
// Bun ESM does not expose the legacy namespaced CJS surface through `import *`,
// so `admin.apps` / `admin.initializeApp` / `admin.firestore()` came back
// undefined and `admin?.apps.length` threw at module load.
// The CJS exports object is reachable as `.default`; under tsc
// /CommonJS the namespace *is* the exports,
// so this resolves to the same object in both runtimes.
const adminNs = (admin as unknown as { default?: typeof admin })
    .default ?? admin
import Stripe from "stripe"
import { defineSecret, defineJsonSecret } from "firebase-functions/params"
import { SecretManagerServiceClient } from "@google-cloud/secret-manager"
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { env, functionsEnvJson } from "../config/env"

const secretManager = new SecretManagerServiceClient()
const EMULATOR_SECRET_PREFIX = "emulator-secret://"
const EMULATOR_SECRETS_COLLECTION = "_emulator_secrets"
export const stripeSecretParam = defineSecret("STRIPE_SECRET_KEY")
export const stripeWebhookSecretParam =
    defineSecret("STRIPE_WEBHOOK_SECRET")
// Holds the Firebase service account JSON in production
// (stored in Secret Manager). Must be listed in `secrets`
// on any Cloud Function that cold-starts a new instance.
export const serviceAccountKeyParam =
    defineJsonSecret("FIRE_SERVICE_ACCOUNT_KEY")
export const stripeSecrets = [stripeSecretParam, stripeWebhookSecretParam,
    functionsEnvJson]
// Sandbox twin of the pair above, bound to the test-mode webhook function.
// A secret name holds one value per project, so the sandbox cannot share the
// live names: a sandbox delivery verified with the live secret is a 400.
export const stripeTestSecretParam = defineSecret("STRIPE_SECRET_KEY_TEST")
export const stripeTestWebhookSecretParam =
    defineSecret("STRIPE_WEBHOOK_SECRET_TEST")
export const stripeTestSecrets = [stripeTestSecretParam,
    stripeTestWebhookSecretParam, functionsEnvJson]
const configuredDbName = (env.DB_NAME || "").trim()
const fallbackDbName = env.IS_PRODUCTION ? "easyscrape" : "(default)"
export const dbName = configuredDbName || fallbackDbName

if (!configuredDbName) {
    const fallbackMessage =
        "DB_NAME not configured. Falling back to Firestore database:"
    console.warn(
        `${fallbackMessage} ${dbName}`
    )
}

const resolveLocalServiceAccount = (): admin.ServiceAccount | null => {
    // `__dirname` is undefined under Bun ESM, and path.resolve(undefined, ...)
    // threw before anything could run — taking down every module that imports
    // this file (all of gfunctions/* and infrastructure/*). There is no local
    // serviceAccount.json on Cloud Run either, so skip the lookup instead of
    // guessing a directory. Inert for the deployed function: tsc emits CommonJS
    // where `__dirname` is always defined.
    const moduleDir = typeof __dirname === "string" ? __dirname : ""

    if (!moduleDir) {
        return null
    }

    const candidatePaths = [
        path.resolve(moduleDir, "../serviceAccount.json"),
        path.resolve(moduleDir, "../../src/serviceAccount.json"),
    ]

    for (const candidatePath of candidatePaths) {
        if (fs.existsSync(candidatePath)) {
            return JSON.parse(
                fs.readFileSync(candidatePath, "utf8")
            ) as admin.ServiceAccount
        }
    }

    console.warn(
        `serviceAccount.json not found. 
        Checked: ${candidatePaths.join(", ")}. ` +
        "Falling back to default Firebase Admin credentials."
    )

    return null
}

const resolveProductionServiceAccount = (): admin.ServiceAccount | null => {
    const fromEnv = process.env["FIRE_SERVICE_ACCOUNT_KEY"]
    if (fromEnv) {
        try {
            return JSON.parse(fromEnv) as admin.ServiceAccount
        } catch {
            console.warn(
                "FIRE_SERVICE_ACCOUNT_KEY is set but not valid JSON. " +
                "Falling back to Secret Manager/local Firebase Admin " +
                "credentials."
            )
        }
    }

    try {
        return serviceAccountKeyParam.value() as admin.ServiceAccount
    } catch {
        console.warn(
            "FIRE_SERVICE_ACCOUNT_KEY is unavailable during initialization. " +
            "Falling back to local/default Firebase Admin credentials."
        )
        return null
    }
}


// Initialize Firebase Admin SDK:
// - Non-production: use the local credentials.json
//   file immediately (safe at deploy time).
// - Production: use defineJsonSecret so the service account key is loaded from
//   Secret Manager at runtime. env.IS_PRODUCTION is false
//   during `firebase deploy`
//   (secret values throw and are caught in env.ts → fallback to false), so
//   serviceAccountKeyParam.value() is never called at deploy time.
// Docs: https://firebase.google.com/docs/admin/setup#initialize_the_sdk_in_non-google_environments
const localServiceAccount = resolveLocalServiceAccount()
const productionServiceAccount = env.IS_PRODUCTION ?
    resolveProductionServiceAccount() :
    null
const selectedServiceAccount = productionServiceAccount || localServiceAccount

// Only initialize Firebase if it hasn't been initialized already
// This prevents errors when multiple modules load config.ts during tests
const wasAlreadyInitialized = adminNs?.apps.length > 0
if (!wasAlreadyInitialized) {
    adminNs.initializeApp(
        selectedServiceAccount ?
            {credential: adminNs.credential.cert(selectedServiceAccount)} :
            undefined
    )
}

export const db = adminNs.firestore()
// Only call settings() if we just initialized Firebase for the first time
// Otherwise, Firestore is already initialized and this call will fail
if (!wasAlreadyInitialized) {
    db.settings({ databaseId: dbName })
}

export const auth = adminNs.auth()

const resolveStripeSecret = (secret: string | undefined) => {
    const candidate = typeof secret === "string" ? secret.trim() : ""

    if (candidate) {
        return candidate
    }

    const fromEnv = env.STRIPE_SECRET_KEY?.trim()
    if (fromEnv) {
        return fromEnv
    }

    return env.STRIPE_SECRET_KEY || ""
}

export const getStripeWebhookSecret = (secret:string | undefined) => {
    try {
        const stripeWebhookKey =
            secret as string | undefined
        return stripeWebhookKey ||
            env.STRIPE_WEBHOOK_SECRET ||
            ""
    } catch {
        return env.STRIPE_WEBHOOK_SECRET || ""
    }
}

let stripeClient: Stripe | null = null

export const getStripe = (secret: string | undefined) => {
    if (stripeClient) {
        return stripeClient
    }

    const stripeSecret = resolveStripeSecret(secret) as string | undefined
    if (!stripeSecret) {
        throw new Error("Missing Stripe secret key")
    }

    if (!stripeSecret.startsWith("sk_")) {
        throw new Error(
            "Invalid Stripe secret key format. Expected prefix sk_"
        )
    }

    stripeClient = new Stripe(stripeSecret)
    return stripeClient
}

// Helper: Generate a secure random API key
/**
 * generateApiKey
 * @return {*}
 */
export function generateApiKey() {
    return crypto.randomBytes(32).toString("hex")
}

/**
 * isEmulatorSecretPath
 * @param {*} secretPath
 * @return {*}
 */
function isEmulatorSecretPath(secretPath: string): boolean {
    return secretPath.startsWith(EMULATOR_SECRET_PREFIX)
}

/**
 * toEmulatorSecretPath
 * @param {*} secretId
 * @return {*}
 */
function toEmulatorSecretPath(secretId: string): string {
    return `${EMULATOR_SECRET_PREFIX}${secretId}`
}

/**
 * fromEmulatorSecretPath
 * @param {*} secretPath
 * @return {*}
 */
function fromEmulatorSecretPath(secretPath: string): string {
    return secretPath.slice(EMULATOR_SECRET_PREFIX.length)
}

/**
 * getEmulatorSecretDoc
 * @param {*} secretId
 * @return {*}
 */
function getEmulatorSecretDoc(secretId: string) {
    return db.collection(EMULATOR_SECRETS_COLLECTION).doc(secretId)
}

/**
 * saveEmulatorSecret
 * @param {*} secretId
 * @param {*} value
 */
async function saveEmulatorSecret(
    secretId: string,
    value: string
): Promise<string> {
    await getEmulatorSecretDoc(secretId).set({
        value,
        updated_At: new Date(),
    }, {merge: true})

    return toEmulatorSecretPath(secretId)
}

/**
 * readEmulatorSecret
 * @param {*} secretPath
 */
async function readEmulatorSecret(secretPath: string): Promise<string> {
    const secretId = fromEmulatorSecretPath(secretPath)
    const snapshot = await getEmulatorSecretDoc(secretId).get()
    const value = snapshot.data()?.["value"]
    return typeof value === "string" ? value : ""
}

/**
 * deleteEmulatorSecret
 * @param {*} secretPath
 */
async function deleteEmulatorSecret(
    secretPath: string
): Promise<SecretPurgeResult> {
    const secretId = fromEmulatorSecretPath(secretPath)
    await getEmulatorSecretDoc(secretId).delete()

    return {
        secretPath,
        versionsDestroyed: 1,
        secretDeleted: true,
    }
}


// Helper: Store API key in Cloud Secret Manager
/**
 * saveToSecretManager
 * @param {*} secretId
 * @param {*} apiKey
 */
export async function saveToSecretManager(
    secretId: string | null | undefined,
    apiKey: string
) {
    if (!secretId) {
        throw new Error("secretId is required")
    }

    if (env.IS_EMULATOR) {
        return saveEmulatorSecret(secretId, apiKey)
    }

    // Create a new secret
    const [secret] = await secretManager.createSecret({
        parent: `projects/${env.GCP_PROJECT_ID}`,
        secretId,
        secret: {
            replication: {
                automatic: {},
            },
        },
    })

    // Add the API key as a new version
    await secretManager.addSecretVersion({
        parent: secret.name,
        payload: {
            data: Buffer.from(apiKey, "utf8"),
        },
    })

    // Assign IAM policy for specific user
    /* const policy = {
        bindings: [
            {
                role: "roles/secretmanager.secretAccessor",
                members: [`user:${userEmail}`],
            },
        ],
    }

    await secretManager.setIamPolicy({
        resource: secret.name,
        policy,
    }) */

    return secret.name
}

/**
 * getSecretFromManager
 * @param {*} secretPath
 */
export async function getSecretFromManager(secretPath: string) {
    if (isEmulatorSecretPath(secretPath)) {
        return readEmulatorSecret(secretPath)
    }

    // Get the secret version
    const [version] = await secretManager.accessSecretVersion({
        name: secretPath + "/versions/latest",
    })
    // Return the API key to show the user
    return version.payload?.data?.toString()
}

export type SecretPurgeResult = {
    secretPath: string
    versionsDestroyed: number
    secretDeleted: boolean
}

/**
 * purgeSecretAndAllRevisions
 * @param {*} secretPath
 */
export async function purgeSecretAndAllRevisions(secretPath: string):
    Promise<SecretPurgeResult> {
    if (isEmulatorSecretPath(secretPath)) {
        return deleteEmulatorSecret(secretPath)
    }

    const [versions] = await secretManager.listSecretVersions({
        parent: secretPath,
    })

    let versionsDestroyed = 0

    for (const version of versions) {
        const versionName = version.name
        const state = version.state

        if (!versionName) {
            continue
        }

        if (state !== "DESTROYED") {
            await secretManager.destroySecretVersion({
                name: versionName,
            })
            versionsDestroyed += 1
        }
    }

    await secretManager.deleteSecret({
        name: secretPath,
    })

    return {
        secretPath,
        versionsDestroyed,
        secretDeleted: true,
    }
}

