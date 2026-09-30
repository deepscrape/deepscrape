/* eslint-disable indent */
/* eslint-disable object-curly-spacing */
/* eslint-disable max-len */
import { Request, Response } from "express"
import { JinaHeader } from "../types"
import fetch, { RequestInit } from "node-fetch"
import { pipeline } from "node:stream/promises"
import { customUrlDecoder } from "../gfunctions"
import { env } from "../config/env"
import { safeTargetUrls } from "../domain/url-guard.domain"
import { AiVendorId } from "../domain/user-ai-settings.domain"
import { readUserAiKey } from "../gfunctions/user-settings"

/**
 * The key to call `vendorId` with: the caller's own if they stored one, else the
 * platform's.
 *
 * One function for all four vendors, because the rule is identical and four copies
 * is four chances for one of them to keep spending the platform's key after a user
 * has supplied their own — a mistake that shows up as a bill, not as an error.
 *
 * It reads the user's key FIRST on purpose: someone who brought a key asked to
 * spend their own quota, and charging them to ours is both a surprise and, at
 * scale, our cost.
 *
 * ponytail: the caller passes the platform key, so a vendor with no platform key
 * still works when the user has stored one. Note the ceiling — a FREE plan cannot
 * reach these routes at all, because they are `paid`-gated in the route table and
 * that runs before this. So BYOK today means "your own quota on a paid plan", not
 * "free access with your own key". Lifting that means teaching `requirePaidAccess`
 * about vendor keys, which is a change to the entitlement guard, not to this file.
 * @param {*} req
 * @param {*} vendorId
 * @param {*} platformKey
 */
const keyFor = async (
    req: Request,
    vendorId: AiVendorId,
    platformKey: string,
): Promise<string> => {
    const uid = req.user?.uid
    if (!uid) {
        return platformKey
    }
    return (await readUserAiKey(uid, vendorId)) ?? platformKey
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

export const openaiAICore = async (req: Request, res: Response) => {
    const apiUrl = env.OPENAI_API_URL
    const apiKey = await keyFor(req, "openai", env.OPENAI_API_KEY)
    try {
        const fetchOptions: RequestInit = {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify(req.body),
        }

        // await handleStreamedApiResponse(apiUrl, fetchOptions, res, 'OpenAI')

        const apiResponse = await fetch(apiUrl, fetchOptions)
        if (!apiResponse.ok) {
            throw new Error(`API error: ${apiResponse.statusText}`)
        }

        if (!apiResponse.body) {
            throw new Error("API response body is empty")
        }

        // Stream data from OpenAI to the client
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-store, no-transform, must-revalidate",
            "Connection": "keep-alive",
            "Pragma": "no-cache",
            "Expires": "0",
        })
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
                    if (!res.write(`${jsonChunk}\n`)) {
                        apiResponse.body?.pause() // Pause the stream if backpressure occurs
                        res.once("drain", () => {
                            apiResponse.body?.resume() // Resume the stream when the client is ready
                        })
                    } // Send chunked data as JSON
                }
            }
        })

        apiResponse.body.on("end", () => {
            if (buffer.trim()) {
                res.write(`${buffer.trim()}\n`) // Send remaining data
            }
            res.end()
        })

        apiResponse.body.on("error", (error: Error) => {
            console.error("Stream error:", error)
            res.status(500).end("Stream error")
        })
    } catch (error) {
        console.error("Error:", error)
        res.status(500).json({ error: "Failed to connect to OpenAI API" })
    }
}

export const groqAICore = async (req: Request, res: Response) => {
    const apiUrl = "https://api.groq.com/openai/v1/chat/completions"
    const apiKey = await keyFor(req, "groq", env.GROQ_API_KEY)
    try {
        const fetchOptions: RequestInit = {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(req.body),
        }

        // await handleStreamedApiResponse(apiUrl, fetchOptions, res, 'GROQAI')

        const apiResponse = await fetch(apiUrl, fetchOptions)
        if (!apiResponse.ok) {
            throw new Error(`API error: ${apiResponse.statusText}`)
        }

        if (!apiResponse.body) {
            throw new Error("API response body is empty")
        }
        // Stream data from OpenAI to the client
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-store, no-transform, must-revalidate",
            "Connection": "keep-alive",
            "Pragma": "no-cache",
            "Expires": "0",
        })

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
                    if (!res.write(`${jsonChunk}\n`)) {
                        apiResponse.body?.pause() // Pause the stream if backpressure occurs
                        res.once("drain", () => {
                            apiResponse.body?.resume() // Resume the stream when the client is ready
                        })
                    } // Send chunked data as JSON
                }
            }
        })

        apiResponse.body.on("end", () => {
            if (buffer.trim()) {
                res.write(`${buffer.trim()}\n`) // Send remaining data
            }
            res.end()
        })

        apiResponse.body.on("error", (error: Error) => {
            console.error("Stream error:", error)
            res.status(500).end("Stream error")
        })
    } catch (error) {
        console.error("Error:", error)
        res.status(500).json({ error: "Failed to connect to GROQAI API" })
    }
}


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
