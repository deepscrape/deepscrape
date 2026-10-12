// /**
//  * Typed environment variables
//  * All variables are validated and accessible with full type safety and dot notation
//  */
import * as dotenvx from "@dotenvx/dotenvx"
dotenvx.config({ quiet: true })

const normalizeUpstashRestUrl = (value: string): string => {
  if (!value) {
    return ''
  }

  try {
    const parsed = new URL(value)
    let hostname = parsed.hostname.trim().toLowerCase()

    if (hostname.endsWith('.upstash.io.upstash.io')) {
      hostname = hostname.replace(/\.upstash\.io\.upstash\.io$/, '.upstash.io')
      parsed.hostname = hostname
      return parsed.toString().replace(/\/$/, '')
    }

    return value
  } catch {
    const trimmed = value.trim()
    return trimmed.replace(/\.upstash\.io\.upstash\.io(?=$|\/)/, '.upstash.io')
  }
}

const deriveUpstashHost = (rawHost: string, rawUrl: string): string => {
  const direct = rawHost.trim()
  if (direct) {
    return direct
  }

  const normalizedUrl = normalizeUpstashRestUrl(rawUrl)
  if (!normalizedUrl) {
    return ''
  }

  try {
    return new URL(normalizedUrl).hostname
  } catch {
    return normalizedUrl
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .trim()
  }
}

const getEnv = () => {
  const env = {
    // Environment configuration
    PRODUCTION: (process.env['PRODUCTION'] || 'false') as 'true' | 'false',
    EMULATORS: (process.env['EMULATORS'] || 'false') as 'true' | 'false',
    HOST: process.env['HOST'] || 'localhost',
    PORT: parseInt(process.env['PORT'] || '4000', 10),

    // Upstash Redis configuration (for rate limiting)
    UPSTASH_REDIS_REST_URL: normalizeUpstashRestUrl(process.env['UPSTASH_REDIS_REST_URL'] || ''),
    UPSTASH_REDIS_REST_HOST: deriveUpstashHost(
      process.env['UPSTASH_REDIS_REST_HOST'] || '',
      process.env['UPSTASH_REDIS_REST_URL'] || ''
    ),
    UPSTASH_REDIS_REST_TOKEN: process.env['UPSTASH_REDIS_REST_TOKEN'] || '',
    UPSTASH_REDIS_REST_PORT: process.env['UPSTASH_REDIS_REST_PORT'] || '30766',
    UPSTASH_REDIS_REST_USER: process.env['UPSTASH_REDIS_REST_USER'] || 'default',
    UPSTASH_REDIS_REST_PASSWORD: process.env['UPSTASH_REDIS_REST_PASSWORD'] || '',

    // API configuration
    API_ARACHNEFLY_URL: process.env['API_ARACHNEFLY_URL'] || 'http://localhost:3000',
    API_CRAWL4AI_URL: process.env['API_CRAWL4AI_URL'] || '',

    // Third-party API Keys
    CRAWL4AI_API_KEY: process.env['CRAWL4AI_API_KEY'] || '',
    GOOGLE_API_KEY: process.env['GOOGLE_API_KEY'] || '',
    JINAAI_API_KEY: process.env['JINAAI_API_KEY'] || '',
    ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'] || '',
    OPENAI_API_KEY: process.env['OPENAI_API_KEY'] || '',
    GROQ_API_KEY: process.env['GROQ_API_KEY'] || '',

    // GCP / Firebase / Stripe / Recaptcha keys
    GCP_PROJECT_ID: process.env['GCP_PROJECT_ID'] || '',
    API_KEY: process.env['API_KEY'] || '',
    AUTH_DOMAIN: process.env['AUTH_DOMAIN'] || '',
    DATABASE_URL: process.env['DATABASE_URL'] || '',
    PROJECT_ID: process.env['PROJECT_ID'] || '',
    STORAGE_BUCKET: process.env['STORAGE_BUCKET'] || '',
    MESSAGING_SENDER_ID: process.env['MESSAGING_SENDER_ID'] || '',
    APP_ID: process.env['APP_ID'] || '',
    MEASUREMENT_ID: process.env['MEASUREMENT_ID'] || '',
    RECAPTCHA_KEY: process.env['RECAPTCHA_KEY'] || '',
    STRIPE_PUBLIC_KEY: process.env['STRIPE_PUBLIC_KEY'] || '',
  } as const

  // Validate required variables in production
  if (env.PRODUCTION === 'true') {
    const required = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const
    required.forEach(key => {
      if (!env[key]) {
        console.warn(`⚠️  Missing required environment variable in production: ${key}`)
      }
    })
  }

  return env
}

export const env = getEnv()
export type Env = typeof env
