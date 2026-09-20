/* eslint-disable max-len */
/* eslint-disable indent */
/* eslint-disable linebreak-style */
// eslint-disable-next-line object-curly-spacing
import { Redis } from "@upstash/redis"
import chalk from "chalk"
import {env} from "../config/env"

export const sanitizeUpstashRestUrl = (value: string): string => {
    if (!value) {
        return ""
    }

    // Strip surrounding whitespace and trailing slashes
    let normalized = value.trim().replace(/\/+$/, "")

    // Deduplicate malformed hostnames like *.upstash.io.upstash.io
    normalized = normalized.replace(/\.upstash\.io\.upstash\.io(\/|$)/, ".upstash.io$1")

    return /^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`
}

export const isEncryptedPlaceholder = (value: string): boolean =>
    /^encrypted:/i.test((value || "").trim())

export const isHttpUrl = (value: string): boolean => {
    try {
        const parsed = new URL(value)
        return parsed.protocol === "http:" || parsed.protocol === "https:"
    } catch {
        return false
    }
}

// Initialize Upstash Redis client
const upstashUrl = sanitizeUpstashRestUrl(env.UPSTASH_REDIS_REST_URL)
const upstashToken = env.UPSTASH_REDIS_REST_TOKEN || env.UPSTASH_REDIS_REST_PASSWORD
const upstashRestEnabled =
    !!upstashUrl &&
    !!upstashToken &&
    isHttpUrl(upstashUrl) &&
    !isEncryptedPlaceholder(upstashUrl) &&
    !isEncryptedPlaceholder(upstashToken)
// Chainable no-op pipeline so batched calls stay safe when Upstash REST is not
// configured (dev / emulator / missing credentials). A method missing here is a
// runtime TypeError rather than a silent no-op, so this must cover every command
// routed through `pipeline()`.
const NOOP_PIPELINE_COMMANDS = [
    "get", "getex", "set", "setex", "del", "incr", "incrby", "expire", "ttl",
    "zadd", "zremrangebyscore", "zcount", "zcard", "zrange",
    "lpush", "lrange", "lpop", "rpop", "ltrim", "llen",
] as const

const createNoopPipeline = (): Record<string, unknown> => {
    const pipeline: Record<string, unknown> = {
        exec: async () => [],
    }
    for (const command of NOOP_PIPELINE_COMMANDS) {
        pipeline[command] = () => pipeline
    }
    return pipeline
}

const createNoopRedis = (): Redis => ({
    pipeline: createNoopPipeline,
    get: async () => null,
    getex: async () => null,
    set: async () => "OK",
    setex: async () => "OK",
    del: async () => 0,
    incr: async () => 0,
    incrby: async () => 0,
    expire: async () => 0,
    ttl: async () => -2,
    zadd: async () => 0,
    zremrangebyscore: async () => 0,
    zcount: async () => 0,
    zcard: async () => 0,
    zrange: async () => [],
    lpush: async () => 0,
    lrange: async () => [],
    lpop: async () => null,
    // Paired with lpush above: the analytics drain consumes the tail (RPOP) so a
    // FIFO queue does not starve its oldest entries.
    rpop: async () => null,
    ltrim: async () => "OK",
    llen: async () => 0,
    // Hot-path scripts. Returning the "nothing cached" shape lets callers fall
    // through to Firestore rather than aborting the request.
    eval: async () => [null, "ok"],
    // `undefined` is the documented "store unavailable" signal for
    // rate-limit-redis: it falls back to its in-memory store instead of throwing.
    exec: async () => undefined,
} as unknown as Redis)

const redis: Redis = upstashRestEnabled ? new Redis({
    url: upstashUrl,
    token: upstashToken,
}) : createNoopRedis()

/**
 * Run a Lua script through the shared client.
 *
 * `@upstash/redis` exposes `eval`, but the no-op fallback models only the
 * commands the app uses, so the cast lives here once instead of at every call
 * site — a missing method on that stub is a runtime TypeError, not a no-op.
 *
 * @param {string} script Lua source to execute.
 * @param {string[]} keys Keys the script may access.
 * @param {(string | number)[]} args Positional script arguments.
 * @return {Promise<TData>} Whatever the script returns.
 */
export const redisEval = async <TData>(
    script: string,
    keys: string[],
    args: (string | number)[],
): Promise<TData> =>
    (redis as unknown as {
        eval: (script: string, keys: string[], args: (string | number)[]) => Promise<TData>
    }).eval(script, keys, args)

/**
 * Whether the process is talking to a real Redis instance.
 *
 * Rate limiting and reporting must branch on this rather than probing the client:
 * a no-op client answers every command successfully, so the only reliable signal
 * is whether the client was constructed from real credentials.
 */
const isRedisEnabled = upstashRestEnabled

if (upstashRestEnabled) {
    console.log(chalk.hex("#028C9E").bold("Upstash Redis REST client initialized ") + chalk.yellow.bold(upstashUrl))
} else {
    console.warn(
        "Upstash Redis REST client DISABLED: REST URL/token missing or still encrypted. " +
        "Session cache, geo cache and rate limiting will fall back to Firestore / process memory.",
    )
}

/*
 * The ioredis TCP client that used to live here is gone.
 *
 * It existed solely to feed `rate-limit-redis` through `express-rate-limit`,
 * which meant a second wire protocol, a second credential path and a second
 * failure mode alongside the REST client used by every other code path. Its
 * username was also synthesized as `${username}_ro`, which does not exist on the
 * configured Upstash instance, so the connection failed AUTH and the limiter
 * silently degraded to per-instance memory storage.
 *
 * Rate limiting now runs on the REST client below (see `handlers/limiter.ts`).
 */

/**
 * Upstash's REST client auto-deserializes JSON by default, so a value written with
 * `JSON.stringify` comes back as an already-parsed object, NOT a string. Every
 * `typeof v === "string"` guard around a cache read was therefore false, which
 * silently disabled the session, revocation, device-trust and geo caches.
 *
 * Verified against a live instance: `get()` -> typeof "object", and
 * `pipeline().exec()` -> [object, object, ...] in command order.
 * Normalizing here means callers never have to care which shape they got.
 * @param {*} value
 * @return {*}
 */
export const parseCachedJson = <T>(value: unknown): T | null => {
    if (value === null || value === undefined) {
        return null
    }
    if (typeof value === "string") {
        try {
            return JSON.parse(value) as T
        } catch {
            return null
        }
    }
    return value as T
}

export {redis, isRedisEnabled}
