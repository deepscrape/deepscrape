import { AI_VENDORS, AIModel, AiVendorId, DropDownOption, ModelFacts, OpenAiChatVendor, OpenAITokenDetails, modelCodeForVendor } from "../types";
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

/**
 * The cost of one completion, in USD.
 *
 * `facts` is optional and comes from the live model registry, which is the only source that
 * knows about a model shipped after this file was written. Pass it whenever the caller has it.
 * @param {OpenAITokenDetails} usage The token counts the vendor reported.
 * @param {string} model The model id the call was made with.
 * @param {ModelFacts} facts Facts for that model, when the caller has them.
 * @return {number} The cost in USD, or 0 when the model cannot be priced.
 */
export function calculateOpenAICost(usage: OpenAITokenDetails, model: string, facts?: ModelFacts): number {


    const MODEL_COSTS: Record<string, { promptCost: number; completionCost: number }> = {
        "gpt-4-turbo": { promptCost: 0.03, completionCost: 0.06 },
        "gpt-4": { promptCost: 0.06, completionCost: 0.12 },
        "gpt-3.5": { promptCost: 0.02, completionCost: 0.04 }, // Example rates for GPT-3.5
        "gpt-4o-mini": { promptCost: 0.00015, completionCost: 0.0006 }, // Fixed: was 100x the real rate
        "gpt-3.5-turbo": { promptCost: 0.025, completionCost: 0.05 }, // Example rates for GPT-3.5 Turbo
        // Both Groq rows were written as PER-MILLION values -- $0.05/M and $0.59/M are Groq's
        // published prices -- while this table is per 1K and the arithmetic below divides by
        // 1000. A Groq call therefore displayed 1000x its real cost. Same numbers, read in the
        // unit they were written in; the registry cannot cover these, because LiteLLM no longer
        // lists Groq's llama ids at all.
        "llama-3.1-8b-instant": { promptCost: 0.00005, completionCost: 0.00008 },
        "llama-3.3-70b-versatile": { promptCost: 0.00059, completionCost: 0.00079 },
        "claude-3-5-sonnet-20240620": { promptCost: 0.003, completionCost: 0.015 },
        "claude-3-5-sonnet-20241022": { promptCost: 0.003, completionCost: 0.015 },
        "claude-3-haiku-20240307": { promptCost: 0.00025, completionCost: 0.00125 },
        "claude-3-5-haiku-20241022": { promptCost: 0.001, completionCost: 0.005 },
        // Current lineup, added 2026-10-12 from the vendors' own published prices.
        // Rates are per 1K tokens because the arithmetic below divides by 1000, and
        // they are the real prices rather than estimates -- several rows above are
        // historical guesses (`gpt-3.5-turbo` lists $25/MTok against a real $0.50) and
        // were left as they are so this change stays additive.
        "gpt-6-astra": { promptCost: 0.01, completionCost: 0.05 },
        "gpt-6.1-sol": { promptCost: 0.002, completionCost: 0.01 },
        "gpt-6-luna": { promptCost: 0.0001, completionCost: 0.0005 },
        "claude-fable-5-1": { promptCost: 0.01, completionCost: 0.05 },
        "claude-opus-5-5": { promptCost: 0.004, completionCost: 0.02 },
        "claude-sonnet-5-5": { promptCost: 0.002, completionCost: 0.01 },
        "claude-haiku-5-5": { promptCost: 0.0001, completionCost: 0.0005 },
        // The rows above are RETAINED on purpose, and they are now the only ones serving their
        // models: the picker offers each vendor's LIVE catalogue, and a vendor can still return
        // one of these older ids. An unknown model is priced at ZERO rather than fatal (see
        // below), so a missing row is a silently wrong cost, not a visible failure. Deleting a
        // row is therefore a pricing decision, never housekeeping.
        // Add more models here if needed
    }
    // Retrieve cost rates for the model from the configuration object.
    //
    // A model with no rate row is priced at ZERO rather than fatal. That reverses what this
    // did, and the reason is that the model list is no longer a constant in this file: the
    // picker reads each vendor's LIVE catalogue, so the set of models a caller can
    // legitimately pick is not knowable here. A throw would turn "the vendor shipped a
    // model" into "chat is broken", which is the exact failure the live catalogue exists
    // to avoid.
    //
    // The ceiling is real and worth naming: an unpriced model under-reports OUR cost, so
    // the spend figure shown in `app-llm-scrape` reads zero for it. That is a DISPLAY gap,
    // not a billing error -- credits are charged by the route guard from the pricing
    // policy, not from this number.
    //
    // The live registry is consulted FIRST, which closes most of that gap. The table below is a
    // fallback for the models it does not carry, and the table is the part that rots -- its own
    // rows are admitted guesses and it cannot know a model shipped after it was written. Nothing
    // belongs here that the registry already answers.
    //
    // Both rates are required before the registry counts as an answer: half a price (input
    // known, output not) would under-report silently, so a partial pair falls through to the
    // table instead.
    const liveRates = facts?.inputCostPerMTokens !== undefined && facts.outputCostPerMTokens !== undefined
        ? {
            // per MILLION -> per 1K, the unit the arithmetic below uses. This is the only place
            // the two units meet, and the wrong factor mis-states a price by 1000x, so the
            // conversion sits next to the division that reads it.
            promptCost: facts.inputCostPerMTokens / 1000,
            completionCost: facts.outputCostPerMTokens / 1000,
        }
        : undefined;
    const costRates = liveRates ?? MODEL_COSTS[model];
    if (!costRates) {
        console.warn(`No rate row for model "${model}"; reporting its cost as zero.`);
        return 0;
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
 * Which vendor a model NAME belongs to, when the name alone can say so.
 *
 * This answers the TRANSPORT question -- which endpoint and which key -- and it can only
 * answer it for the two vendors that spoke the OpenAI wire protocol when it was written.
 * Every vendor added since is reached by naming it EXPLICITLY at the call site, from the
 * dropdown's `code`, because guessing a company from a model name is how a request ends up
 * at the wrong one on the caller's key. `openai` for an unrecognised name preserves what
 * the boolean this replaced did; the explicit path is what the app actually uses.
 *
 * ponytail: the unknown name still falls through to OpenAI. Make it a throw once every
 * caller passes an explicit vendor -- the chat already does, and `app-llm-scrape`'s
 * dropdown codes are the remaining one.
 * @param {string} modelName The model id as the caller named it.
 * @return {OpenAiChatVendor} The vendor the name belongs to, or `openai` when the name is new.
 */
export const vendorForModel = (modelName: string): OpenAiChatVendor =>
  GROQ_MODELS.has(modelName) ? 'groq' : 'openai'

export function setAIModel(newModel: DropDownOption[]) {
    const model = [
        // OpenAI. `gpt-4-turbo`, `gpt-4` and `gpt-3.5-turbo` were REMOVED, not merely
        // refreshed: all three shut down on 2026-10-23 (announced 2026-04-22), so they
        // would have begun failing days after this edit and the failure would have read
        // as a new bug rather than a scheduled retirement. `gpt-4o-mini` stays because
        // it is still served and is the cheapest working OpenAI option here.
        { name: 'gpt-6-astra', code: 'openai' },
        { name: 'gpt-6.1-sol', code: 'openai' },
        { name: 'gpt-6-luna', code: 'openai' },
        { name: 'gpt-4o-mini', code: 'openai' },
        // Groq: deliberately unchanged. Nothing in this pass verified Groq's current
        // lineup, and guessing at model ids is how this list rots a second time.
        { name: 'llama-3.1-8b-instant', code: 'groq' },
        { name: 'llama-3.3-70b-versatile', code: 'groq' },
        // Anthropic, in the order the model docs present them. The whole 3.x generation
        // is gone; every model below takes tools and images, which the chat's tool loop
        // depends on. Ids verified against the vendor docs on 2026-10-12.
        { name: 'claude-opus-5-5', code: 'claude' },
        { name: 'claude-sonnet-5-5', code: 'claude' },
        { name: 'claude-haiku-5-5', code: 'claude' },
        { name: 'claude-fable-5-1', code: 'claude' },
    ]
    newModel.push(...model)
}

/** * Whether the registry says this model is already gone.
 *
 * A `YYYY-MM-DD` string compares lexicographically, so no date parsing is needed. Facts that are
 * absent mean the registry has never heard of the model, which is NOT the same as retired.
 * @param {ModelFacts | undefined} facts The facts for the model, when there are any.
 * @return {boolean} True once the registry's date has passed.
 */
export const isRetired = (facts: ModelFacts | undefined): boolean =>
    facts?.deprecatedOn !== undefined && facts.deprecatedOn <= new Date().toISOString().slice(0, 10);

/** * The models a picker may offer, and the vendors it could not offer any for.
 *
 * Pure and exported so the spec can pin the rule, which is the interesting part:
 *
 *  - a vendor the server resolved as USABLE is offered with its LIVE catalogue;
 *  - a vendor whose catalogue could not be read falls back to the static list rather than
 *    disappearing, because a vendor being briefly unreachable must not empty the picker;
 *  - a vendor with neither is reported in `missing` rather than guessed at. Inventing a model
 *    id here is how a list rots, and offering none is the honest answer.
 *
 * A vendor the caller CANNOT use is omitted rather than shown greyed. The refusal is already
 * stated in the settings panel, and `DropdownComponent` has no disabled state -- adding one
 * would change a component every picker in the app shares, for this single case.
 *
 * `allowed: null` means the server has not said who is usable (the settings call failed, or has
 * not returned). The static list is then offered unfiltered, which is exactly the behaviour
 * from before this gating existed: an empty picker would be a NEW failure mode introduced by a
 * feature meant to prevent one.
 *
 * It lives beside `setAIModel` rather than in a component because THREE pickers need the same
 * rule -- chat, the LLM-scrape form and operations. Three copies of this is three answers to
 * "which models may I choose" that drift the first time one of them is edited.
 * @param {readonly AiVendorId[] | null} allowed The vendors the server resolved as usable.
 * @param {Readonly<Record<string, string[]>>} live The fetched catalogue, per vendor.
 * @param {readonly AIModel[]} fallback The static list, already built by `setAIModel`.
 * @return {{ options: AIModel[]; missing: AiVendorId[] }} The options, and the gaps.
 */
export function buildModelOptions(
    allowed: readonly AiVendorId[] | null,
    live: Readonly<Record<string, string[]>>,
    fallback: readonly AIModel[],
    facts: Readonly<Record<string, ModelFacts>> = {},
): { options: AIModel[]; missing: AiVendorId[] } {
    const options: AIModel[] = [];
    const missing: AiVendorId[] = [];
    const candidates = allowed ?? AI_VENDORS.map(vendor => vendor.id);

    for (const vendor of candidates) {
        const code = modelCodeForVendor(vendor);
        const fetched = live[vendor] ?? [];
        const fromLive = fetched.length > 0;
        // The retirement filter applies to the FALLBACK only. A stale fallback is the one place a
        // retired model can still reach the picker -- the vendor's live catalogue drops a model
        // when it goes, while this list changes only when someone edits it, which is how three
        // shut-down OpenAI models came to be listed here by hand. The live half is left alone
        // because the VENDOR is the authority on what it serves today, and a third party's date
        // must not overrule it.
        const ids = fromLive
            ? fetched
            : fallback
                .filter(model => model.code === code)
                .map(model => model.name)
                .filter(name => !isRetired(facts[name]));

        if (ids.length === 0) {
            missing.push(vendor);
            continue;
        }

        options.push(...ids.map(name => ({ name, code })));
    }

    return { options, missing };
}

export function constructCookiesforJina(cookies: { name: string, value: string, domain: string }[]): string {
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}; domain=${cookie.domain}`).join(', ')
}