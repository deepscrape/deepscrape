/**
 * Drop-in replacement for the unmaintained `useragent@2.3.0` package.
 * Wraps `ua-parser-js` (actively maintained) behind the same
 * `.parse(ua)` → `{ family, os.family, device.family, toString() }` surface,
 * plus bot / AI-agent flags from the `bot-detection` submodule.
 *
 * Only the fields actually used in the codebase are mapped.
 */

import {UAParser} from "ua-parser-js"
import {isAIAssistant, isAICrawler, isBot} from "ua-parser-js/bot-detection"

export type BotKind = "ai-assistant" | "ai-crawler" | "bot" | null

export interface AgentInfo {
  family: string
  os: { family: string }
  device: { family: string }
  isBot: boolean
  botKind: BotKind
  toString(): string
}

/**
 * Classify a UA string. AI agents are checked first so the more specific
 * label wins (they are also plain bots/crawlers to `isBot`).
 */
/**
 * detectBot
 * @param {*} ua
 * @return {*}
 */
function detectBot(ua: string): { isBot: boolean, botKind: BotKind } {
  if (isAIAssistant(ua)) return {isBot: true, botKind: "ai-assistant"}
  if (isAICrawler(ua)) return {isBot: true, botKind: "ai-crawler"}
  const bot = isBot(ua)
  return {isBot: bot, botKind: bot ? "bot" : null}
}

/**
 * Parse a User-Agent string and return an object compatible with the old
 * `useragent` package API.
 *
 * ponytail: bot detection takes the raw UA string on purpose. Passing a parsed
 * result silently returns false because the result is built without the bot
 * extensions — verified against Googlebot/GPTBot/ChatGPT-User.
 */
/**
 * parseUA
 * @param {*} rawUA
 * @return {*}
 */
export function parseUA(rawUA: string): AgentInfo {
  const ua = rawUA || ""
  const parser = new UAParser(ua)
  const r = parser.getResult()
  const bot = detectBot(ua)

  return {
    family: r.browser.name || "Other",
    os: {family: r.os.name || "Other"},
    device: {family: r.device.type || r.device.model || "Other"},
    isBot: bot.isBot,
    botKind: bot.botKind,
    toString: () => ua,
  }
}
