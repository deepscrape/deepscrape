export const API_ANTHROPIC = '/api/anthropic'
export const API_OPENAI = '/api/openai'
export const API_GROQAI = '/api/groq'

export const API_JINAAI = '/api/jina'

/**
 * The platform's own API base, which is the Bun/Elysia BFF.
 *
 * It was called `API_CRAWL4AI_URL`, which named the platform after one of the
 * providers it consumes. That was not only wrong, it collided: the BFF has its own
 * `API_CRAWL4AI_URL` env var (`functions/src/config/env.ts`) that really does point
 * at a third-party host (`https://crawlagent.fly.dev`, legacy). One name, two
 * meanings, two layers, is how a client ends up pointed at a vendor by a "fix".
 *
 * The architecture this name has to reflect: there are two backend services,
 * **arachnefly** (Go/Fiber, Fly machine lifecycle) and **webrain** (Rust engine, MCP
 * over HTTP), and the client addresses NEITHER directly. Every call goes to the BFF
 * at `/api`, which relays on the caller's behalf and holds the credentials. A client
 * that named a service here would be one refactor away from bypassing it.
 */
export const API_BASE_URL = '/api'