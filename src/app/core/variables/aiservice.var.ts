export const API_ANTHROPIC = '/api/anthropic'
export const API_OPENAI = '/api/openai'
export const API_GROQAI = '/api/groq'
export const API_DEEPSEEK = '/api/deepseek'
export const API_FIREWORKS = '/api/fireworks'
export const API_QWEN = '/api/qwen'
export const API_KIMI = '/api/kimi'
export const API_OPENROUTER = '/api/openrouter'
export const API_GEMINI = '/api/gemini'
export const API_CUSTOM = '/api/custom'

/**
 * The model catalogue base. One dynamic segment per vendor is appended to it.
 *
 * A dynamic route rather than one registration per vendor: the BFF validates the segment
 * against its own catalogue, so an unknown vendor is a 404 and the browser cannot cause a
 * request to anything that is not ours.
 */
export const API_MODELS = '/api/models'

export const API_JINAAI = '/api/jina'

/**
 * The system prompt a model gets when its caller supplies none.
 *
 * Both defaults in `AiAPIService` used to be a recipe-extraction template from the app this
 * code grew out of, so a caller that scaffolded no prompt asked the model to "extract all
 * recipe information from website content" -- an instruction that has nothing to do with
 * scraping and reaches the customer's transcript when it fires. A neutral assistant prompt is
 * the honest default for a service that cannot know its caller's job.
 *
 * ONE copy, deliberately: the chat passes its own prompt and the service falls back to this,
 * and two literals would drift into two products.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  "You are deepscrape's assistant. Reply in concise markdown.",
  '',
  'You act through tools on a real platform; a tool description is the contract, and reading it before calling is cheaper than guessing.',
  '',
  'Browser sessions are leased machines. They bill from creation until stop_session, and their /work is wiped when the machine stops.',
  '1. Before browser work, call list_sessions to see what the caller already has.',
  '2. create_session returns a live session with `reused: true` instead of buying a second one; say so, because it may still hold their logins. Pass fresh only when they want a clean browser.',
  '3. Call stop_session when the browser work is finished, or the meter keeps running.',
  '4. Inside a session, run_command has no network: fetch with scrape or observe, then parse the result. Keep anything worth keeping with write_file, because /work does not survive.',
  '',
  'When the user names many URLs or expects to come back later, create_job outlives this conversation; prefer it to scraping page by page.',
  '',
  'You have a limited number of tool rounds per answer. Plan to finish inside it; when it runs out, say what you gathered and what is left.',
  'Never claim a tool ran when it failed. Say what failed, and what you would do instead.',
].join('\n')

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