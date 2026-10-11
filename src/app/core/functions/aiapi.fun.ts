import { OpenAITokenDetails, DropDownOption } from "../types";
import { sanitizeJSON } from "./global.fun";

/**
 * Convert a string into batches of bytes and push each batch to the messages array.
 * @param messages The array to which the batches will be added.
 * @param subcontent The string to be converted into batches.
 */
export function chatInBatchesAI(messages: { role: string, content: string }[], subcontent: string) {
    const encoder = new TextEncoder();
    const bytesLength = encoder.encode(subcontent).length;
    const chunkSize = 1024;

    messages.push({
        role: 'user', content: `To provide the context for the above prompt,
        I will send you text in parts. When I am finished, I will tell you 
        'ALL PARTS SENT'. Do not answer until you have received all the parts.` })

    for (let i = 0; i < Math.ceil(bytesLength / chunkSize); i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, bytesLength)
        const chunk = subcontent.slice(start, end).trim()
        if (chunk.length < 1) break;
        // const chunkBytesLength = (await encodeToBytes(chunk)).length;
        // console.log(`Chunk ${i + 1} of ${Math.ceil(bytesLength / chunkSize)}:`, `(${formatBytes(chunkBytesLength)})`);
        messages.push({ role: 'user', content: sanitizeJSON(chunk) })
    }
    messages.push({ role: 'user', content: 'ALL PARTS SENT' })
}

export function calculateOpenAICost(usage: OpenAITokenDetails, model: string): number {


    const MODEL_COSTS: Record<string, { promptCost: number; completionCost: number }> = {
        "gpt-4-turbo": { promptCost: 0.03, completionCost: 0.06 },
        "gpt-4": { promptCost: 0.06, completionCost: 0.12 },
        "gpt-3.5": { promptCost: 0.02, completionCost: 0.04 }, // Example rates for GPT-3.5
        "gpt-4o-mini": { promptCost: 0.015, completionCost: 0.03 }, // Example rates for GPT-4 OpenAI mini
        "gpt-3.5-turbo": { promptCost: 0.025, completionCost: 0.05 }, // Example rates for GPT-3.5 Turbo
        "llama-3.1-8b-instant": { promptCost: 0.05, completionCost: 0.08 },
        "llama-3.3-70b-versatile": { promptCost: 0.59, completionCost: 0.79 },
        "claude-3-5-sonnet-20240620": { promptCost: 0.003, completionCost: 0.015 },
        "claude-3-5-sonnet-20241022": { promptCost: 0.003, completionCost: 0.015 },
        "claude-3-haiku-20240307": { promptCost: 0.00025, completionCost: 0.00125 },
        "claude-3-5-haiku-20241022": { promptCost: 0.001, completionCost: 0.005 },
        // Add more models here if needed
    }
    // Retrieve cost rates for the model from the configuration object
    const costRates = MODEL_COSTS[model];
    if (!costRates) {
        throw new Error("Unknown model specified");
    }

    // Extract token counts
    const { prompt_tokens, completion_tokens, prompt_tokens_details } = usage;
    const cached_tokens = prompt_tokens_details?.cached_tokens || 0;

    // Calculate non-cached prompt tokens
    const non_cached_prompt_tokens = prompt_tokens - cached_tokens;

    // Calculate costs
    const prompt_cost = (non_cached_prompt_tokens / 1000) * costRates.promptCost
    const completion_cost = (completion_tokens / 1000) * costRates.completionCost

    // Total cost
    const total_cost = prompt_cost + completion_cost;

    return parseFloat(total_cost.toFixed(5)); // Round to 5 decimal places
}


/**
 * The Groq model family, by name.
 *
 * This replaced a 40-line `switch` that returned a 4-element tuple assembled from
 * two PARALLEL ARRAYS of endpoints and keys, with a `default` that sent any
 * unrecognised model to OpenAI. That shape is why the mapping read as both
 * unreachable and duplicated: `sendToClaudeAI` already fixes its provider, so the
 * switch there only echoed its own argument back, and the one caller that needed a
 * real decision -- `sendToOpenAI` -- re-derived from a model name what the model
 * table already encodes as `code`.
 *
 * Membership is explicit rather than a prefix test on purpose. `llama`, `gemma` and
 * `whisper` are Groq's today, but a prefix rule would silently misroute the day
 * OpenAI ships a `llama`. Cost of being wrong here is a request to the wrong
 * vendor on the caller's key.
 */
const GROQ_MODELS: ReadonlySet<string> = new Set([
  'distil-whisper-large-v3-en',
  'gemma2-9b-it',
  'gemma-7b-it',
  'llama-3.3-70b-versatile',
  'llama-3.1-70b-versatile',
  'llama-3.1-8b-instant',
  'llama-guard-3-8b',
  'llama3-70b-8192',
  'llama3-8b-8192',
  'mixtral-8x7b-32768',
  'whisper-large-v3',
  'whisper-large-v3-turbo',
])

/**
 * Whether a model name is served by Groq rather than OpenAI.
 *
 * Both vendors speak the same wire protocol, so this is the ONLY difference
 * between the two paths: which endpoint and which key the request carries. An
 * unrecognised name answers OpenAI, which is what the old `default` did -- but
 * stated once, here, instead of buried in the fourth position of a tuple.
 *
 * ponytail: unknown names still fall through to OpenAI, matching the previous
 * behaviour exactly. Flip to a throw when a misroute is ever observed in the wild.
 * @param {string} modelName The model id as the caller named it.
 * @return {boolean} True when the name belongs to Groq's family.
 */
export const isGroqModel = (modelName: string): boolean =>
  GROQ_MODELS.has(modelName)

export function setAIModel(newModel: DropDownOption[]) {
    const model = [
        { name: 'gpt-4-turbo', code: 'openai' },
        { name: 'gpt-4', code: 'openai' },
        { name: 'gpt-3.5', code: 'openai' },
        { name: 'gpt-4o-mini', code: 'openai' },
        { name: 'gpt-3.5-turbo', code: 'openai' },
        { name: 'llama-3.1-8b-instant', code: 'groq' },
        { name: 'llama-3.3-70b-versatile', code: 'groq' },
        { name: 'claude-3-5-sonnet-20240620', code: 'claude' },
        { name: 'claude-3-5-sonnet-20241022', code: 'claude' },
        { name: 'claude-3-haiku-20240307', code: 'claude' },
        { name: 'claude-3-5-haiku-20241022', code: 'claude' },
    ]
    newModel.push(...model)
}

export function constructCookiesforJina(cookies: { name: string, value: string, domain: string }[]): string {
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}; domain=${cookie.domain}`).join(', ')
}