/* eslint-disable max-len */
/**
 * Typed environment variables for Firebase Functions
 * All variables are validated and accessible with full type safety and dot notation
 */
// import * as dotenvx from "@dotenvx/dotenvx"
import {defineJsonSecret} from "firebase-functions/params"

export const functionsEnvJson = defineJsonSecret("FUNCTIONS_ENV_JSON")

type RuntimeConfigValue = string | number | boolean | null | undefined
type RuntimeConfigMap = Record<string, RuntimeConfigValue>

// type BuildMode = "development" | "staging" | "production"

// const normalizeMode = (value: string | undefined): BuildMode => {
//   const mode = (value || "").trim().toLowerCase()

//   if (mode === "dev" || mode === "development") {
//     return "development"
//   }

//   if (mode === "stage" || mode === "staging") {
//     return "staging"
//   }

//   return "production"
// }

// const mode = normalizeMode(process.env["BUILD_ENV"] || process.env["APP_ENV"] || process.env["NODE_ENV"])


// const envFilesByMode: Record<BuildMode, string[]> = {
//   development: [".env.local", ".env.dev"],
//   staging: [".env.staging"],
//   production: [".env"],
// }

// const selectedEnvFiles = envFilesByMode[mode]

// dotenvx.config({quiet: true, path: selectedEnvFiles, debug: true, verbose: true}, )

const parseEnvList = (value: string): string[] => {
  if (!value) {
    return []
  }

  const trimmed = value.trim()

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => String(item).trim().toLowerCase())
          .filter(Boolean)
      }
    } catch {
      // Fallback to comma parsing below
    }
  }

  return trimmed
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

const normalizeUpstashRestUrl = (value: string): string => {
  if (!value) {
    return ""
  }

  try {
    const parsed = new URL(value)
    let hostname = parsed.hostname.trim().toLowerCase()

    if (hostname.endsWith(".upstash.io.upstash.io")) {
      hostname = hostname.replace(/\.upstash\.io\.upstash\.io$/, ".upstash.io")
      parsed.hostname = hostname
      return parsed.toString().replace(/\/$/, "")
    }

    return value
  } catch {
    const trimmed = value.trim()
    return trimmed.replace(/\.upstash\.io\.upstash\.io(?=$|\/)/, ".upstash.io")
  }
}

const deriveUpstashHost = (rawHost: string, rawUrl: string): string => {
  const direct = rawHost.trim()
  if (direct) {
    return direct
  }

  const normalizedUrl = normalizeUpstashRestUrl(rawUrl)
  if (!normalizedUrl) {
    return ""
  }

  try {
    return new URL(normalizedUrl).hostname
  } catch {
    return normalizedUrl
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .trim()
  }
}

const parseBoolean = (value: string | undefined, defaultValue = false): boolean => {
  if (typeof value !== "string") {
    return defaultValue
  }

  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return defaultValue
  }

  return ["1", "true", "yes", "on"].includes(normalized)
}

const getSecretConfig = (): RuntimeConfigMap => {
  try {
    const value = functionsEnvJson.value()
    if (value && typeof value === "object") {
      return value as RuntimeConfigMap
    }
  } catch {
    // Secret values are not available during deployment manifest generation.
  }

  return {}
}

const getConfigValue = (key: string, fallback = ""): string => {
  const fromProcess = process.env[key]
  if (typeof fromProcess === "string" && fromProcess !== "") {
    return fromProcess
  }

  const fromSecret = getSecretConfig()[key]
  if (typeof fromSecret === "string") {
    return fromSecret
  }

  if (typeof fromSecret === "number" || typeof fromSecret === "boolean") {
    return String(fromSecret)
  }

  return fallback
}

const getEnv = () => {
  const env = {
    // Environment configuration
    PRODUCTION: (getConfigValue("PRODUCTION", "false")) as "true" | "false",
    IS_PRODUCTION: parseBoolean(getConfigValue("PRODUCTION", "false"), false),
    COOKIE_SECRET: getConfigValue("COOKIE_SECRET"),
    CSRF_COOKIE_SECRET: getConfigValue("CSRF_COOKIE_SECRET"),
    DB_NAME: getConfigValue("DB_NAME", "easyscrape"),
    IS_EMULATOR: parseBoolean(process.env["FUNCTIONS_EMULATOR"], false) || !!process.env["FIREBASE_EMULATOR_HUB"],
    DOTENV_PRIVATE_KEY: getConfigValue("DOTENV_PRIVATE_KEY"),
    PORT: parseInt(getConfigValue("PORT", "4000"), 10),
    // Upstash Redis configuration (sessions, presence, analytics, rate limiting)
    UPSTASH_REDIS_REST_URL: normalizeUpstashRestUrl(getConfigValue("UPSTASH_REDIS_REST_URL")),
    UPSTASH_REDIS_REST_HOST: deriveUpstashHost(
      getConfigValue("UPSTASH_REDIS_REST_HOST"),
      getConfigValue("UPSTASH_REDIS_REST_URL")
    ),
    UPSTASH_REDIS_REST_TOKEN: getConfigValue("UPSTASH_REDIS_REST_TOKEN"),
    UPSTASH_REDIS_REST_PORT: getConfigValue("UPSTASH_REDIS_REST_PORT", "30766"),
    UPSTASH_REDIS_REST_USER: getConfigValue("UPSTASH_REDIS_REST_USER", "default"),
    UPSTASH_REDIS_REST_PASSWORD: getConfigValue("UPSTASH_REDIS_REST_PASSWORD"),

    // API configuration
    API_ARACHNEFLY_URL: getConfigValue("API_ARACHNEFLY_URL", "https://arachnefly.fly.dev"),
    API_CRAWL4AI_URL: getConfigValue("API_CRAWL4AI_URL", "https://crawlagent.fly.dev"),

    // webrain MCP worker (the Rust scraping engine).
    //
    // No default host on purpose. The other two keep a default because they are
    // deployed and long-standing; a NEW provider must not inherit "some host is
    // assumed", which is how an arbitrary worker gets used without anyone choosing
    // it. Empty means the route fails with a clear message (`infrastructure/webrain-mcp.ts`
    // reports it as a transport error). Locally: http://127.0.0.1:9223
    // (or whichever `--http <port>` the server was started with).
    //
    // A token is only needed when the worker was started with WEBRAIN_HTTP_TOKEN;
    // unset here means no Authorization header is sent, which is the correct
    // local-stdio default. On the shared free-tier pool it must be set, as
    // defence in depth behind the gateway — it is NOT a tenancy boundary.
    WEBRAIN_MCP_URL: getConfigValue("WEBRAIN_MCP_URL", ""),
    WEBRAIN_MCP_TOKEN: getConfigValue("WEBRAIN_MCP_TOKEN"),

    // QStash — the job queue. These ARE runtime secrets: the service publishes
    // work and verifies the signature on the delivery endpoint, so unlike the Box
    // key they belong in this module and in the deploy secret lists.
    //
    // No default URL. The documented global host exists, but a region-pinned token
    // (qstash-eu-central-1.upstash.io) must be sent to its own region, and a
    // default here would silently route it elsewhere. Empty means the queue is
    // unconfigured, which should read as "not set up" rather than "delivered to
    // the wrong region".
    QSTASH_URL: getConfigValue("QSTASH_URL", ""),
    QSTASH_TOKEN: getConfigValue("QSTASH_TOKEN"),
    // Two signing keys, not one: QStash rotates them, and verification must accept
    // the CURRENT and the NEXT during a rotation window. A single key means every
    // rotation drops in-flight deliveries as forgeries.
    QSTASH_CURRENT_SIGNING_KEY: getConfigValue("QSTASH_CURRENT_SIGNING_KEY"),
    QSTASH_NEXT_SIGNING_KEY: getConfigValue("QSTASH_NEXT_SIGNING_KEY"),

    // Which provider `/api/crawl` uses: 'crawl4ai' (the default) or 'webrain'.
    // The default keeps an unconfigured deployment byte-for-byte as it was, so
    // turning webrain on is a config change and turning it back off is too.
    SCRAPE_PROVIDER: getConfigValue("SCRAPE_PROVIDER", "crawl4ai"),

    // Third-party API Keys
    JINAAI_API_KEY: getConfigValue("JINAAI_API_KEY"),
    // Shared crawl-worker credential, sent as `Authorization: Bearer <this>`.
    // It was declared only in src/config/env.ts (the root module), so the crawl
    // handler had nothing to resolve and relayed the caller's own token instead.
    // Verified against the worker: a relayed user token is a 401, this is a 200.
    // In production it must be present in the FUNCTIONS_ENV_JSON secret.
    CRAWL4AI_API_KEY: getConfigValue("CRAWL4AI_API_KEY"),
    ANTHROPIC_API_KEY: getConfigValue("ANTHROPIC_API_KEY"),
    OPENAI_API_URL: getConfigValue("OPENAI_API_URL", "https://api.openai.com/v1/chat/completions"),
    OPENAI_API_KEY: getConfigValue("OPENAI_API_KEY"),
    GROQ_API_KEY: getConfigValue("GROQ_API_KEY"),
    RESEND_API_KEY: getConfigValue("RESEND_API_KEY"),
    RESEND_FROM_EMAIL: getConfigValue("RESEND_FROM_EMAIL"),
    // Origin of the AUTHENTICATED app — settings, login, billing. An email link must be
    // absolute or it is a dead link, hence the hard-coded default. Still the apex today;
    // set it to the dashboard origin at cutover.
    APP_ORIGIN: getConfigValue("APP_ORIGIN", "https://deepscrape.dev"),
    // Origin of the public marketing site. Deliberately not the same constant as
    // APP_ORIGIN: the two diverge at the subdomain split, and an "Appeal" link belongs on
    // the marketing contact page while a "Sign in" link must not.
    MARKETING_ORIGIN: getConfigValue("MARKETING_ORIGIN", "https://deepscrape.dev"),
    AUTHZ_STRICT_ORG_MODE: getConfigValue("AUTHZ_STRICT_ORG_MODE", "false"),

    // Google Cloud & Stripe
    GCP_PROJECT_ID: getConfigValue("GCP_PROJECT_ID"),
    ADMIN_EMAILS: parseEnvList(getConfigValue("ADMIN_EMAILS")),
    STRIPE_SECRET_KEY: getConfigValue("STRIPE_SECRET_KEY"),
    STRIPE_WEBHOOK_SECRET: getConfigValue("STRIPE_WEBHOOK_SECRET"),
    STRIPE_PUBLIC_KEY: getConfigValue("STRIPE_PUBLIC_KEY"),
    STRIPE_PRICE_STARTER_PAYG: getConfigValue("STRIPE_PRICE_STARTER_PAYG"),
    STRIPE_PRICE_STARTER_MONTHLY: getConfigValue("STRIPE_PRICE_STARTER_MONTHLY"),
    STRIPE_PRICE_STARTER_QUARTERLY: getConfigValue("STRIPE_PRICE_STARTER_QUARTERLY"),
    STRIPE_PRICE_STARTER_ANNUAL: getConfigValue("STRIPE_PRICE_STARTER_ANNUAL"),
    STRIPE_PRICE_PRO_PAYG: getConfigValue("STRIPE_PRICE_PRO_PAYG"),
    STRIPE_PRICE_PRO_MONTHLY: getConfigValue("STRIPE_PRICE_PRO_MONTHLY"),
    STRIPE_PRICE_PRO_QUARTERLY: getConfigValue("STRIPE_PRICE_PRO_QUARTERLY"),
    STRIPE_PRICE_PRO_ANNUAL: getConfigValue("STRIPE_PRICE_PRO_ANNUAL"),
    STRIPE_PRICE_ENTERPRISE_MONTHLY: getConfigValue("STRIPE_PRICE_ENTERPRISE_MONTHLY"),
    STRIPE_PRICE_ENTERPRISE_QUARTERLY: getConfigValue("STRIPE_PRICE_ENTERPRISE_QUARTERLY"),
    STRIPE_PRICE_ENTERPRISE_ANNUAL: getConfigValue("STRIPE_PRICE_ENTERPRISE_ANNUAL"),
    STRIPE_PRICE_CREDITS_100: getConfigValue("STRIPE_PRICE_CREDITS_100"),
    STRIPE_PRICE_CREDITS_500: getConfigValue("STRIPE_PRICE_CREDITS_500"),
    STRIPE_PRICE_CREDITS_2000: getConfigValue("STRIPE_PRICE_CREDITS_2000"),
    STRIPE_TRIAL_PERIOD_DAYS: getConfigValue("STRIPE_TRIAL_PERIOD_DAYS", "14"),
    BILLING_TRIAL_DEFAULT_CREDITS: getConfigValue("BILLING_TRIAL_DEFAULT_CREDITS", "160"),
    BILLING_TRIAL_DEFAULT_CREDIT_CAP_EUR: getConfigValue("BILLING_TRIAL_DEFAULT_CREDIT_CAP_EUR", "160"),
    BILLING_PRICING_RULES_JSON: getConfigValue("BILLING_PRICING_RULES_JSON", ""),
    BILLING_CUSTOM_CREDITS_MIN: getConfigValue("BILLING_CUSTOM_CREDITS_MIN", "50"),
    BILLING_CUSTOM_CREDITS_MAX: getConfigValue("BILLING_CUSTOM_CREDITS_MAX", "5000"),
    BILLING_CUSTOM_CREDIT_UNIT_AMOUNT_EUR: getConfigValue("BILLING_CUSTOM_CREDIT_UNIT_AMOUNT_EUR", "19"),
    BILLING_CREDIT_EXPIRY_DAYS: getConfigValue("BILLING_CREDIT_EXPIRY_DAYS", "365"),
    IP_GEO_API_URL: getConfigValue("IP_GEO_API_URL", "https://ip.deepscrape.dev/api/geo/lookup"),
    IPREGISTRY_API_KEY: getConfigValue("IPREGISTRY_API_KEY"),
    IP_INTEL_REFRESH_INTERVAL_MS: getConfigValue("IP_INTEL_REFRESH_INTERVAL_MS", "21600000"),

    // WebAuthn / Passkey configuration
    RP_NAME: getConfigValue("RP_NAME", "DeepScrape"),
    RP_ORIGIN: getConfigValue("RP_ORIGIN", "http://localhost:4200"),
  } as const

  const finalEnv = {
    ...env,
    TRUST_PROXY: env.IS_PRODUCTION || env.IS_EMULATOR,
  } as const

  // Validate required variables in production
  if (finalEnv.IS_PRODUCTION) {
    const required = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const
    required.forEach((key) => {
      if (!finalEnv[key]) {
        console.warn(`⚠️  Missing required environment variable in production: ${key}`)
      }
    })
  }

  return finalEnv
}

export const env = getEnv()
export type Env = typeof env
