// generate-env.ts
import fs from 'fs'
import dotenvx from '@dotenvx/dotenvx'

type BuildMode = 'development' | 'staging' | 'production'

const normalizeMode = (value: string | undefined): BuildMode => {
    const mode = (value || '').trim().toLowerCase()

    if (mode === 'dev' || mode === 'development') {
        return 'development'
    }

    if (mode === 'stage' || mode === 'staging') {
        return 'staging'
    }

    return 'production'
}

const mode = normalizeMode(process.env['BUILD_ENV'] || process.env['APP_ENV'] || process.env['NODE_ENV'])

const envFilesByMode: Record<BuildMode, string[]> = {
    development: ['.env.dev'],
    staging: ['.env.staging'],
    production: ['.env'],
}

const selectedEnvFiles = envFilesByMode[mode]
const result = dotenvx.config({ quiet: true, path: selectedEnvFiles/* , debug: true,verbose: true, */ })
const env = { ...(result.parsed || {})/* , ...process.env  */}

console.log(`[prod_gen] mode=${mode} files=${selectedEnvFiles.join(', ')}`)
// console.log('Loaded environment variables:', env);
const environment = {
    production: env["PRODUCTION"] === "true",
    emulators: env["EMULATORS"] === "true",
    assetsUri: "https://deepscrape.dev/assets/",
    wsUrl: "wss://agent.deepscrape.dev", //  || "ws://crawlagent.fly.dev"
    nekoUrl: "wss://neko-rtc.fly.dev",
    firebaseConfig: {
        apiKey: env["API_KEY"],
        authDomain: env["AUTH_DOMAIN"],
        databaseURL: env["DATABASE_URL"],
        projectId: env["PROJECT_ID"],
        storageBucket: env["STORAGE_BUCKET"],
        messagingSenderId: env["MESSAGING_SENDER_ID"],
        appId: env["APP_ID"],
        measurementId: env["MEASUREMENT_ID"] || "G-G709SMG382"
    },
    STRIPE_PUBLIC_KEY: env["STRIPE_PUBLIC_KEY"],
    RECAPTCHA_KEY: env["RECAPTCHA_KEY"],
    // Public Web Push certificate key (Firebase Console > Cloud Messaging).
    // Optional: NotificationService reports 'unconfigured' when absent.
    FIREBASE_VAPID_KEY: env["FIREBASE_VAPID_KEY"] || "",
    OPENAI_API_KEY: "",// env["OPENAI_API_KEY"],
    ANTHROPIC_API_KEY: "", // env["ANTHROPIC_API_KEY"],
    JINAAI_API_KEY: "", // env["JINAAI_API_KEY"],
    GROQ_API_KEY: "", // env["GROQ_API_KEY"],
    GOOGLE_API_KEY: "", // env["GOOGLE_API_KEY"],
    CRAWL4AI_API_KEY: "", // env["CRAWL4AI_API_KEY"],
    API_CRAWL4AI_URL: env["API_CRAWL4AI_URL"] || "https://crawlagent.fly.dev",
    API_ARACHNEFLY_URL: env["API_ARACHNEFLY_URL"] || "https://arachnefly.fly.dev",
    API_ANTHROPIC: "https://api.anthropic.com",
    API_OPENAI: "https://api.openai.com",
    API_GROQ: "https://api.groq.com",
    API_JINAAI: "https://r.jina.ai",
}

const content = `export const environment = ${JSON.stringify(environment, null, 2)};`

// This file is the single source of truth for every build mode. The production and
// staging configurations used to replace `environment.ts` with the hand-maintained
// `prod.ts` / `staging.ts`, which silently discarded everything generated here — that is
// how production shipped an empty FIREBASE_VAPID_KEY ("Push is not configured for this
// build") while this file held the real key. Keep `fileReplacements` empty in
// angular.json; the mode is selected by which dotenv file `prbuild*` loads.
fs.writeFileSync('src/environments/environment.ts', content)