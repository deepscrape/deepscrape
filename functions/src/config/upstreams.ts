/* eslint-disable object-curly-spacing */
/**
 * Upstream base URLs — resolved in ONE place.
 *
 * Why this module exists
 * ---------------------
 * `handlers/machines.ts` (9x) and `handlers/crawler.ts` (6x) each repeated the
 * same expression:
 *
 *     env.PRODUCTION === "true"
 *       ? env.API_ARACHNEFLY_URL || "https://arachnefly.fly.dev"
 *       : "http://localhost:8080"
 *
 * Three things were wrong with that, and the repetition is what hid all three:
 *
 * 1. **The `|| "https://…fly.dev"` branch is dead.** `config/env.ts` already
 *    supplies that exact default in `getConfigValue("API_ARACHNEFLY_URL", …)`
 * and `getConfigValue("API_CRAWL4AI_URL", …)`, so `env.API_ARACHNEFLY_URL` is
 *    never empty and the fallback can never run. It is the same class of bug as
 *    the `CRAWL4AI_API_KEY !== '' ? url : url` no-op that was removed from the
 *    client: it reads as a considered fallback and is not one.
 *
 * 2. **It made an arbitrary third-party host look sanctioned.** A reviewer
 *    reading either handler saw a Fly host as the operational default. There is
 *    exactly one default now, it lives beside the env read in `config/env.ts`,
 *    and this module does not re-state it — so a missing value fails loudly at
 *    the fetch instead of silently reaching a host nobody chose.
 *
 * 3. **Two hosts, one expression.** `machines.ts` talks to Arachnefly (which
 *    re-verifies the caller's Firebase ID token — `FireAuthMiddleware` in
 * `arachnefly/interfaces/controller/middleware.go`), `crawler.ts` talks to the
 *    crawl agent (which authenticates with the server-held `CRAWL4AI_API_KEY`).
 *    Sharing the ternary implied they were interchangeable. They are not, so
 *    they get one resolver each.
 *
 * Local development keeps its own host for each service, exactly as before.
 */
import { env } from "./env"

/** Arachnefly control plane. Caller identity is RELAYED: it verifies the token.
 * @return {*}
 */
export const arachneflyBaseUrl = (): string =>
  env.PRODUCTION === "true" ? env.API_ARACHNEFLY_URL : "http://localhost:8080"

/** Crawl agent. Authenticated by OUR secret, never by the caller's token.
 * @return {*}
 */
export const crawlAgentBaseUrl = (): string =>
  env.PRODUCTION === "true" ? env.API_CRAWL4AI_URL : "http://localhost:8000"
