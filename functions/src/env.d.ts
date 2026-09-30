/* eslint-disable max-len */
// NOTE: This file is kept for reference only.
// The actual environment variable access is handled through src/config/env.ts
// which provides a typed wrapper with validation and defaults.
// You can delete this file if preferred, as the env wrapper is now the source of truth.

declare namespace NodeJS {
  interface ProcessEnv {
    // Environment Configuration
    PRODUCTION: "true" | "false"
    PORT: string

    // Upstash Redis Configuration
    UPSTASH_REDIS_REST_URL: string
    UPSTASH_REDIS_REST_HOST: string
    UPSTASH_REDIS_REST_TOKEN: string
    QSTASH_URL: string
    QSTASH_TOKEN: string
    QSTASH_CURRENT_SIGNING_KEY: string
    QSTASH_NEXT_SIGNING_KEY: string
    UPSTASH_REDIS_REST_PORT: string
    UPSTASH_REDIS_REST_USER: string
    UPSTASH_REDIS_REST_PASSWORD: string
    COOKIE_SECRET: string
    CSRF_COOKIE_SECRET?: string

    // External API URLs
    API_ARACHNEFLY_URL: string
    API_CRAWL4AI_URL: string
    WEBRAIN_MCP_URL: string
    WEBRAIN_MCP_TOKEN: string
    SCRAPE_PROVIDER: string

    // AI API Keys
    JINAAI_API_KEY: string
    ANTHROPIC_API_KEY: string
    OPENAI_API_URL: string
    OPENAI_API_KEY: string
    GROQ_API_KEY: string

    // Google Cloud Platform & Stripe
    GCP_PROJECT_ID: string
    DB_NAME: string
    STRIPE_PUBLIC_KEY: string
    STRIPE_PRICE_STARTER_PAYG: string
    STRIPE_PRICE_STARTER_MONTHLY: string
    STRIPE_PRICE_STARTER_QUARTERLY: string
    STRIPE_PRICE_STARTER_ANNUAL: string
    STRIPE_PRICE_PRO_PAYG: string
    STRIPE_PRICE_PRO_MONTHLY: string
    STRIPE_PRICE_PRO_QUARTERLY: string
    STRIPE_PRICE_PRO_ANNUAL: string
    STRIPE_PRICE_ENTERPRISE_MONTHLY: string
    STRIPE_PRICE_ENTERPRISE_QUARTERLY: string
    STRIPE_PRICE_ENTERPRISE_ANNUAL: string
    STRIPE_PRICE_CREDITS_100: string
    STRIPE_PRICE_CREDITS_500: string
    STRIPE_PRICE_CREDITS_2000: string
    IP_INTEL_REFRESH_INTERVAL_MS: string
  }
}
