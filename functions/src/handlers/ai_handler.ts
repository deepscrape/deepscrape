/* eslint-disable indent */
/* eslint-disable object-curly-spacing */
/* eslint-disable max-len */
import { Request, Response } from "express"
import { JinaHeader } from "../types"
import fetch, { RequestInit, type Response as FetchResponse } from "node-fetch"
import { pipeline } from "node:stream/promises"
import { customUrlDecoder } from "../gfunctions"
import { env } from "../config/env"
import { factsForIds, modelFactsWithin } from "../domain/model-facts.domain"
import { safeTargetUrls } from "../domain/url-guard.domain"
import { AiVendorId, ProviderKeyId, isAiVendorId } from "../domain/user-ai-settings.domain"
import { readUserAiEndpoint, readUserAiKey } from "../gfunctions/user-settings"

/**
 * The key to call `vendorId` with: the caller's own if they stored one, else the
 * platform's.
 *
 * One function for every upstream, because the rule is identical and a copy per provider is a
 * copy that can forget the caller's key — a mistake that shows up as a bill, not as an error.
 *
 * It takes a `ProviderKeyId` rather than an `AiVendorId` because a reader's credential is
 * chosen by the same rule: `jina` is a scrape provider, and the store has to hold its key
 * without pretending it is a chat vendor.
 *
 * It reads the user's key FIRST on purpose: someone who brought a key asked to
 * spend their own quota, and charging them to ours is both a surprise and, at
 * scale, our cost.
 *
 * The free case is the one that must never fall through
 * ----------------------------------------------------
 * A FREE caller only reaches these routes because `requirePaidOrByok` found a key
 * for this vendor, so the platform must never pay for one. The fallback below is
 * therefore refused outright rather than taken when the read comes back empty:
 * `readUserAiKey` returns null for a secret purged while its metadata survived, and
 * honouring `?? platformKey` there would spend our credits on a plan that does not
 * include them — the exact bug `user-ai-settings.domain.ts` names. A race with no
 * silent charge beats a race that bills us.
 *
 * The window is narrow on purpose: the guard has already confirmed a key exists, so
 * this is a purged-secret race rather than a normal path.
 * @param {*} req
 * @param {*} vendorId
 * @param {*} platformKey
 */
export const keyFor = async (
    req: Request,
    vendorId: ProviderKeyId,
    platformKey: string,
): Promise<string> => {
    const uid = req.user?.uid
    if (!uid) {
        return platformKey
    }

    const userKey = await readUserAiKey(uid, vendorId)

    if (req.accessMode === "free") {
        if (!userKey) {
            throw new Error(`free-byok-key-missing:${vendorId}`)
        }
        return userKey
    }

    return userKey ?? platformKey
}

const toSingleParam = (value: string | string[] | undefined): string =>
    Array.isArray(value) ? (value[0] || "") : (value || "")

const toHeaderValue = (value: string | string[] | undefined, fallback = ""): string => {
    if (Array.isArray(value)) {
        return value[0] || fallback
    }
    return value || fallback
}

export const crawl4aiCore = async (req: Request, res: Response) => {
    // const decodedUrl = decodeURIComponent(url) // decode the URL
    const apiUrl = `${env.API_CRAWL4AI_URL}/crawl`
    const { urls, priority } = req.body

    // ponytail: the crawler agent egresses on our behalf and nothing downstream
    // blocks private space, so an unvalidated list here is an internal-read
    // primitive — POST /api/crawl {"urls":["http://169.254.169.254/latest/meta-data/iam/"]}
    // returns the metadata body to the caller. That guard now lives in
    // `domain/url-guard.domain.ts`, so the webrain path cannot grow a second copy
    // of the regex; read that module for what it covers and for the redirect half
    // it cannot.
    const safeUrls = safeTargetUrls(urls)

    if (!safeUrls.length) {
        res.status(400).json({ error: "Invalid target URLs" })
        return
    }

    const body = {
        urls: safeUrls,
        priority,
    }

    // ponytail: this used to relay the CALLER's own `authorization` header to the
    // crawl worker. Two things were wrong with it. It pushed every tenant's
    // Firebase ID token into a shared, multi-tenant process; and it could not
    // authenticate, because a worker started with WEBRAIN_HTTP_TOKEN wants
    // `Authorization: Bearer <secret>` (webrain-mcp/src/lib.rs) and answers 401 to
    // anything else. Verified against the real binary: no auth -> 401, relayed
    // user token -> 401, server-held secret -> 200.
    //
    // This credential is ours — BFF to our own worker. It is neither the end
    // user's nor a provider's: JinaAI stays a separate provider with its own key
    // on `jinaAICrawl` below, and crawl4ai stays a separate provider too. Only the
    // pattern is shared, never the upstream.
    //
    // ponytail: still crawl4ai-shaped. `POST /crawl` with `{urls, priority}` and
    // the `X-*` option headers are crawl4ai's contract, and the response is read
    // as `response.data.{title,url,usage.tokens,content}`. When the webrain binary
    // serves these features as API + MCP, the path, the request shape and the
    // response shape all move to webrain's typed JSON + `challenge` contract. This
    // function is where that swap lands, so keep the provider shape here and the
    // webrain shape out of the client types.
    const headers: JinaHeader = {
        "Authorization": `Bearer ${env.CRAWL4AI_API_KEY}`,
        "Accept": req.headers["accept"] as string || "application/json",
        "X-With-Iframe": req.headers["x-with-iframe"] as string || "false",
        "X-Return-Format": req.headers["x-return-format"] as string || "markdown",
        "X-Target-Selector": req.headers["x-target-selector"] as string || "body",
        "X-With-Generated-Alt": req.headers["x-with-generated-alt"] as string || "true",
    }

    // ponytail: the client-supplied `x-set-cookie` passthrough was removed here.
    // It let a caller plant cookies into the crawler's request context (session
    // fixation). Nothing legitimately needs to set cookies on this read path.
    try {
        const fetchOptions: RequestInit = {
            method: "POST",
            headers: headers,
            body: JSON.stringify(body),
            compress: true,
        }

        const apiResponse = await fetch(apiUrl, fetchOptions)

        if (!apiResponse.ok) {
            throw new Error(`API error: ${apiResponse.statusText}`)
        }

        if (!apiResponse.body) {
            throw new Error("API response body is empty")
        }


        // One path for both shapes: pipe what the worker sends and report the
        // worker's own content-type. This used to buffer the whole body, hard-code
        // `application/octet-stream`, and force the client into
        // `JSON.parse(arrayBufferToString(...))` on an arraybuffer — a content-type
        // that lied about the payload, with a second half-written streaming helper
        // sitting commented out beside it.
        //
        // No Content-Length: the length is unknown until the upstream finishes, and
        // declaring one would truncate or hang the response.
        res.writeHead(apiResponse.status, {
            "Content-Type": apiResponse.headers.get("content-type") || "application/json",
            "Cache-Control": "no-cache, no-store, must-revalidate",
        })

        // `node:stream/promises` exports pipeline directly; the shim this replaces
        // existed only because the import came from `node:stream`.
        await pipeline(apiResponse.body, res)
    } catch (error) {
        console.error("Error:", error)
        // A pipe can fail after the headers are already on the wire; calling
        // `res.status()` then throws inside the catch and takes the request down.
        if (!res.headersSent) {
            res.status(500).json({ error: "Failed to stream on crawl API" })
        }
    }
}

export const jinaAICrawl = async (req: Request, res: Response) => {
    const url = toSingleParam(req.params.url as string | string[] | undefined)
    const apiKey = await keyFor(req, "jina", env.JINAAI_API_KEY)

    const headers: JinaHeader = {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
        "X-With-Iframe": req.headers["x-with-iframe"] as string || "false",
        "X-Return-Format": req.headers["x-return-format"] as string || "markdown",
        "X-Target-Selector": req.headers["x-target-selector"] as string || "body",
        "X-With-Generated-Alt": req.headers["x-with-generated-alt"] as string || "true",
    }

    // ponytail: the client-supplied `x-set-cookie` passthrough was removed here.
    // It let a caller plant cookies into the upstream fetch context (session
    // fixation). Nothing legitimately needs to set cookies on a read-only fetch.
    const decoded = customUrlDecoder(url)

    // ponytail: the decoder is base64+reverse+Caesar(-3) — obfuscation, not a
    // signature — so it must not be the only thing standing between a caller and
    // the project's JinaAI key. Require an http(s) target; r.jina.ai is a fixed
    // host so this closes quota/cost abuse, not SSRF.
    if (!/^https?:\/\/[^\s]+$/i.test(decoded) || decoded.length > 2048) {
        res.status(400).json({ error: "Invalid target URL" })
        return
    }

    const apiUrl = `https://r.jina.ai/${customUrlDecoder(url)}`

    try {
        const fetchOptions: RequestInit = {
            method: "GET",
            headers: headers,
        }

        const apiResponse = await fetch(apiUrl, fetchOptions)

        if (!apiResponse.ok) {
            throw new Error(`API error: ${apiResponse.statusText}`)
        }
        if (!apiResponse.body) {
            throw new Error("API response body is empty")
        }
        const buffer = await apiResponse.arrayBuffer()
        res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": buffer.byteLength, // Add Content-Length header
        })

        // await streamPipeline(apiResponse.body, res);
        res.end(Buffer.from(buffer))
    } catch (error) {
        console.error("Error:", error)
        res.status(500).json({ error: "Failed to stream on jina API" })
    }
}

export const anthropicAICore = async (req: Request, res: Response) => {
    const apiUrl = "https://api.anthropic.com/v1/messages"
    const apiKey = await keyFor(req, "anthropic", env.ANTHROPIC_API_KEY)
    // console.log(apiKey,)
    try {
        const fetchOptions: RequestInit = {
            method: "POST",
            headers: {
                "x-api-key": apiKey,
                "anthropic-version": toHeaderValue(req.headers["anthropic-version"]),
                "content-type": toHeaderValue(req.headers["content-type"], "application/json"),
            },
            body: JSON.stringify(req.body),
        }
        const apiResponse = await fetch(apiUrl, fetchOptions)

        if (!apiResponse.ok) {
            throw new Error(`API error: ${apiResponse.statusText}`)
        }

        if (!apiResponse.body) {
            throw new Error("API response body is empty")
        }
        // Stream data from Anthropic to the client
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-store, no-transform, must-revalidate",
            "Connection": "keep-alive",
            "Pragma": "no-cache",
            "Expires": "0",
        })

        // await handleStreamedApiResponse(apiUrl, fetchOptions, res, 'Anthropic')

        // Accumulate chunks and send them line-by-line
        let buffer = ""

        apiResponse.body.on("data", (chunk: Buffer) => {
            const text = new TextDecoder("utf-8").decode(chunk)
            buffer += text

            let boundary: number
            while ((boundary = buffer.indexOf("\n")) !== -1) {
                const jsonChunk = buffer.slice(0, boundary).trim()
                buffer = buffer.slice(boundary + 1)

                if (jsonChunk) {
                    if (!res.write(`${jsonChunk}\n`)) { // Send chunked data as JSON
                        apiResponse.body?.pause() // Pause the stream if backpressure occurs
                        res.once("drain", () => {
                            apiResponse.body?.resume() // Resume the stream when the client is ready
                        })
                    }
                }
            }
        })

        apiResponse.body.on("end", () => {
            if (buffer.trim()) {
                if (!res.write(`${buffer.trim()}\n`)) { // Send remaining data
                    apiResponse.body?.pause() // Pause the stream if backpressure occurs
                    res.once("drain", () => {
                        apiResponse.body?.resume() // Resume the stream when the client is ready
                    })
                }
            }
            res.end()
        })

        apiResponse.body.on("error", (error: Error) => {
            console.error("Stream error:", error)
            res.status(500).end("Stream error")
        })
    } catch (error) {
        console.error("Error:", error)
        res.status(500).json({ error: "Failed to stream on Anthropic API" })
    }
}

/**
 * The vendors that serve an OpenAI-shaped chat completion.
 *
 * `anthropic` is absent because it speaks its own protocol and has its own handler.
 * `custom` is absent because its URL is the CALLER's: it has no entry in the table below and
 * its own handler reads the stored endpoint instead, so leaving it in this type would promise
 * a row that does not exist.
 */
export type OpenAiVendor = Exclude<AiVendorId, "anthropic" | "custom">

/**
 * Vendors that publish a model catalogue: every chat vendor, Anthropic included.
 *
 * No `jina` exclusion is needed any more -- it is a scrape provider and is not in `AiVendorId`
 * at all. It had to be carved out of both of these types for exactly as long as it was wrongly
 * listed as a chat vendor.
 */
export type ChatVendor = AiVendorId

/**
 * The OpenAI-compatible vendors, and where each one is reached.
 *
 * One table because the protocol is one protocol: these vendors differ only by a URL and
 * a credential. Stating that once is what makes a new vendor a ROW rather than another
 * ninety-line copy of the streaming plumbing below -- and the two copies this replaced
 * had already drifted apart, one hard-coding its URL while the other read it from `env`.
 *
 * `key` is read when the module loads, not per request: `env` is built at boot, so
 * re-reading it inside a handler would buy nothing. `keyFor` still decides per request
 * WHOSE key is used, and for a BYOK-only vendor (see `user-ai-settings.domain.ts`) this
 * value is empty by design -- the caller's key is the only one that exists.
 *
 * `models` is explicit rather than derived by trimming `/chat/completions`, because a
 * wrong catalogue URL fails SILENTLY: the picker just keeps its static fallback, so the
 * mistake would never surface. Seven visible strings beat one clever regex.
 */
const VENDOR_WIRE: Readonly<
    Record<OpenAiVendor, { chat: string; models: string; key: string }>
> = {
    openai: {
        chat: "https://api.openai.com/v1/chat/completions",
        models: "https://api.openai.com/v1/models",
        key: env.OPENAI_API_KEY,
    },
    groq: {
        chat: "https://api.groq.com/openai/v1/chat/completions",
        models: "https://api.groq.com/openai/v1/models",
        key: env.GROQ_API_KEY,
    },
    deepseek: {
        chat: "https://api.deepseek.com/chat/completions",
        models: "https://api.deepseek.com/models",
        key: env.DEEPSEEK_API_KEY,
    },
    fireworks: {
        chat: "https://api.fireworks.ai/inference/v1/chat/completions",
        models: "https://api.fireworks.ai/inference/v1/models",
        key: env.FIREWORKS_API_KEY,
    },
    qwen: {
        chat: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
        models: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
        key: env.QWEN_API_KEY,
    },
    kimi: {
        chat: "https://api.moonshot.ai/v1/chat/completions",
        models: "https://api.moonshot.ai/v1/models",
        key: env.KIMI_API_KEY,
    },
    openrouter: {
        chat: "https://openrouter.ai/api/v1/chat/completions",
        models: "https://openrouter.ai/api/v1/models",
        key: env.OPENROUTER_API_KEY,
    },
    // Google's OpenAI-compatibility layer, which is why Gemini needs no special case: the
    // native `generateContent` protocol is a different shape, and this path is not.
    gemini: {
        chat: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        models: "https://generativelanguage.googleapis.com/v1beta/openai/models",
        key: env.GEMINI_API_KEY,
    },
}

/**
 * One chat completion, streamed, for any OpenAI-compatible vendor.
 *
 * The vendor is bound at registration rather than read from the request, so the ROUTE
 * decides where a path reaches and a caller cannot redirect their request to another
 * vendor's URL by naming a model from it.
 *
 * No `stream_options` or `stop` rewriting happens here, on purpose: the body is relayed
 * as the client sent it, exactly as the three per-vendor copies did. Adding vendor
 * quirks belongs in the body the client builds, where the model is known.
 * @param {OpenAiVendor} vendor Which vendor's endpoint and platform key this uses.
 * @return {*} The Express handler for that vendor.
 */
/**
 * Pipe an upstream SSE body to the caller, line by line, respecting backpressure.
 *
 * Extracted because two handlers now need exactly this -- the table-driven vendor core
 * and the caller's own endpoint -- and because `anthropicAICore` above still carries its
 * own inline copy. The line-splitting is the load-bearing part: the vendors emit
 * `data: {...}` frames, and the client's `scan` expects to see complete LINES rather than
 * whatever chunk boundary the socket happened to produce.
 * @param {FetchResponse} apiResponse The upstream response, already checked `ok`.
 * @param {Response} res The caller's response.
 * @return {void}
 */
const relayChatResponse = (apiResponse: FetchResponse, res: Response): void => {
    const body = apiResponse.body
    if (!body) {
        // Callers check this before writing the response head, but this function is the
        // one that would crash without it -- so the guard lives here as well, and a new
        // caller that forgets gets a 502 instead of an unhandled rejection.
        res.status(502).json({ error: "Upstream returned no body" })
        return
    }

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store, no-transform, must-revalidate",
        "Connection": "keep-alive",
        "Pragma": "no-cache",
        "Expires": "0",
    })

    let buffer = ""

    body.on("data", (chunk: Buffer) => {
        const text = new TextDecoder("utf-8").decode(chunk)
        buffer += text

        let boundary: number
        while ((boundary = buffer.indexOf("\n")) !== -1) {
            const jsonChunk = buffer.slice(0, boundary).trim()
            buffer = buffer.slice(boundary + 1)

            if (jsonChunk) {
                if (!res.write(`${jsonChunk}\n`)) {
                    body.pause() // Pause the stream if backpressure occurs
                    res.once("drain", () => {
                        body.resume() // Resume the stream when the client is ready
                    })
                }
            }
        }
    })

    body.on("end", () => {
        if (buffer.trim()) {
            res.write(`${buffer.trim()}\n`) // Send remaining data
        }
        res.end()
    })

    body.on("error", (error: Error) => {
        console.error("Stream error:", error)
        res.status(500).end("Stream error")
    })
}

export const chatCompletionsCore = (vendor: OpenAiVendor) => {
    const { chat, key } = VENDOR_WIRE[vendor]

    return async (req: Request, res: Response): Promise<void> => {
        const apiKey = await keyFor(req, vendor, key)
        try {
            const apiResponse = await fetch(chat, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`,
                },
                body: JSON.stringify(req.body),
            })

            if (!apiResponse.ok) {
                throw new Error(`API error: ${apiResponse.statusText}`)
            }

            if (!apiResponse.body) {
                throw new Error("API response body is empty")
            }

            relayChatResponse(apiResponse, res)
        } catch (error) {
            console.error("Error:", error)
            res.status(500).json({ error: `Failed to connect to ${vendor} API` })
        }
    }
}

/**
 * The caller's stored custom endpoint, re-validated, or null.
 *
 * The guard runs again here even though the write path already refused a bad value. This
 * is the address the BFF attaches the caller's key to, so a document written before the
 * guard tightened -- or edited by hand -- must not become a request.
 * @param {Request} req The caller's request.
 * @return {Promise<string | null>} The base URL, or null when there is none we may call.
 */
const callerCustomBase = async (req: Request): Promise<string | null> => {
    const uid = req.user?.uid
    return uid ? readUserAiEndpoint(uid) : null
}

/**
 * One chat completion against the CALLER's own endpoint.
 *
 * Separate from `chatCompletionsCore` rather than another row in the table, because this
 * is the one vendor whose URL is not a constant: it comes out of the caller's settings
 * document on every request. It shares `relayChatResponse`, so the streaming is still
 * written once.
 *
 * `redirect: "error"` is load-bearing, not decoration. The endpoint guard judged the HOST
 * of the URL the caller stored; without this, a caller could store an allowed host whose
 * response redirects to `169.254.169.254` and `fetch` would follow it with the caller's
 * key attached. Refusing to follow is exactly the half the guard documents that it cannot
 * cover.
 *
 * ponytail: no outbound timeout. A caller's endpoint that accepts the connection and never
 * answers holds this request open until the platform kills it. Add an `AbortSignal.timeout`
 * here when a slow custom endpoint starts mattering.
 * @param {Request} req The caller's request.
 * @param {Response} res The caller's response.
 * @return {Promise<void>}
 */
export const customChatCompletionsCore = async (
    req: Request,
    res: Response,
): Promise<void> => {
    try {
        const base = await callerCustomBase(req)
        if (!base) {
            res.status(400).json({ error: "custom_endpoint_missing" })
            return
        }

        // No platform fallback exists for this vendor, so the platform key argument is
        // empty on purpose: there is nothing here the platform could ever pay with.
        const apiKey = await keyFor(req, "custom", "")
        const apiResponse = await fetch(`${base}/chat/completions`, {
            method: "POST",
            redirect: "error",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify(req.body),
        })

        if (!apiResponse.ok) {
            throw new Error(`API error: ${apiResponse.statusText}`)
        }

        if (!apiResponse.body) {
            throw new Error("API response body is empty")
        }

        relayChatResponse(apiResponse, res)
    } catch (error) {
        console.error("Error:", error)
        res.status(500).json({ error: "Failed to reach the custom endpoint" })
    }
}

/**
 * Where a vendor's model catalogue lives, and how to authenticate to it.
 *
 * Async and request-taking for one reason: the `custom` vendor's address is in the
 * caller's settings document, not in this file. Every other vendor resolves from the
 * table.
 *
 * Returns null rather than throwing when there is no key or no address, because "we have
 * nothing to ask with" is an ordinary state for a BYOK-only vendor -- the caller has not
 * added a key yet -- and not an error worth a 5xx.
 * @param {Request} req The caller's request, for `keyFor` and the stored endpoint.
 * @param {ChatVendor} vendor The vendor whose catalogue is wanted.
 * @return {Promise<Object|null>} The url and headers to read the catalogue with, or null.
 */
const catalogueFor = async (
    req: Request,
    vendor: ChatVendor,
): Promise<{ url: string; headers: Record<string, string> } | null> => {
    if (vendor === "custom") {
        const base = await callerCustomBase(req)
        const key = await keyFor(req, "custom", "")
        if (!base || !key) {
            return null
        }
        return { url: `${base}/models`, headers: { "Authorization": `Bearer ${key}` } }
    }

    const wire = vendor === "anthropic" ?
        { models: "https://api.anthropic.com/v1/models", key: env.ANTHROPIC_API_KEY } :
        VENDOR_WIRE[vendor]

    const apiKey = await keyFor(req, vendor, wire.key)
    if (!apiKey) {
        return null
    }

    // Anthropic's one protocol difference, in the one place it matters here.
    return vendor === "anthropic" ?
        {
            url: wire.models,
            headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        } :
        { url: wire.models, headers: { "Authorization": `Bearer ${apiKey}` } }
}

/**
 * The model ids a vendor publishes, so the picker can offer what the vendor serves today
 * instead of a list in this repository that goes stale on every release.
 *
 * One route for every vendor, with the vendor taken from the path. The alternative was
 * eight registrations differing by a string, which is eight places to forget when a
 * vendor is added; the validation below is the price and it is one `if`.
 *
 * Every failure answers 200 with an empty list. That is deliberate: the client keeps its
 * static list when a fetch yields nothing, so a vendor that is down, keyless or not
 * entitled must leave the picker untouched rather than empty it. The caller can still read
 * `unavailable` and say which of those it was.
 *
 * `facts` rides along with the ids rather than living behind a route of its own. The picker
 * already calls this once per vendor, so describing the models it just returned is free here
 * and would be a second round trip anywhere else. The ids are what a caller NEEDS; the facts
 * are what it can now stop maintaining by hand -- context window, price per million tokens,
 * and whether a model is multimodal at all, none of which a vendor's own `/models` answers.
 *
 * The two halves fail independently on purpose. Facts come from a public registry that is
 * cached per warm instance and never throws, so a registry outage leaves `facts` empty while
 * the ids still arrive, and the client falls back to its own table exactly as it did before
 * this existed. A vendor outage does the same in reverse.
 * @param {Request} req The caller's request.
 * @param {Response} res The caller's response.
 * @return {Promise<void>}
 */
export const modelsCore = async (req: Request, res: Response): Promise<void> => {
    const vendor = req.params.vendor

    // No `jina` clause is needed any more: it is a scrape provider and is not in `AiVendorId`,
    // so `isAiVendorId` refuses it without a special case. It had to be named explicitly here
    // for exactly as long as it was wrongly listed as a chat vendor.
    if (!isAiVendorId(vendor)) {
        res.status(404).json({ error: "unknown_vendor", models: [] })
        return
    }

    try {
        const catalogue = await catalogueFor(req, vendor)
        if (!catalogue) {
            res.status(200).json({ models: [], unavailable: "no-key" })
            return
        }

        const apiResponse = await fetch(catalogue.url, {
            headers: catalogue.headers,
            redirect: "error",
        })

        if (!apiResponse.ok) {
            res.status(200).json({ models: [], unavailable: apiResponse.status })
            return
        }

        const body = (await apiResponse.json()) as { data?: Array<{ id?: unknown }> }
        const models = (body.data ?? [])
            .map((entry) => entry.id)
            .filter((id): id is string => typeof id === "string")

        res.json({ models, facts: factsForIds(await modelFactsWithin(), models) })
    } catch (error) {
        console.error("Model catalogue failed:", error)
        res.status(200).json({ models: [], unavailable: "error" })
    }
}

// `groqAICore` and `openaiAICore` used to live here, as two ninety-line copies of the
// same streaming plumbing that differed by a URL string. `chatCompletionsCore(vendor)`
// above serves both, and every vendor added since, from the table.


// export const receiveLogs = async (request: Request, response: Response) => {

//     const authHeader = request.headers.authorization
//     if (!authHeader || !authHeader.startsWith('Bearer ')) {
//         return response.status(401).send('Unauthorized')
//     }

//     const token = authHeader.split('Bearer ')[1]
//     try {
//         await admin.verifyIdToken(token);
//         const logs = request.body.split('\n').filter(Boolean)
//         logs.forEach((log: any) => {
//             console.log(log)
//             // pusher.trigger('logs-channel', 'new-log', JSON.parse(log));
//         });
//         return response.sendStatus(200)
//     } catch (error) {
//         console.error('Error:', error);
//         return response.status(401).send('Invalid Token');
//     }

// }
