/* eslint-disable indent */
/* eslint-disable object-curly-spacing */
/* eslint-disable max-len */
import { Request, Response } from "express"
import { JinaHeader } from "../types"
import fetch, { RequestInit } from "node-fetch"
// import { pipeline } from "node:stream"
// import { promisify } from "node:util"
import { customUrlDecoder } from "../gfunctions"
import { env } from "../config/env"

// const streamPipeline = promisify(pipeline)
const toSingleParam = (value: string | string[] | undefined): string =>
    Array.isArray(value) ? (value[0] || "") : (value || "")

const toHeaderValue = (value: string | string[] | undefined, fallback = ""): string => {
    if (Array.isArray(value)) {
        return value[0] || fallback
    }
    return value || fallback
}

// Utility function to handle API requests and streaming
/* const handleStreamedApiResponse = async (
    apiUrl: string,
    fetchOptions: RequestInit,
    res: Response,
    apiName: string,
    contentType = "text/event-stream"
) => {
    try {
        const apiResponse = await fetch(apiUrl, fetchOptions)

        if (!apiResponse.ok) {
            throw new Error(`API error: ${apiResponse.statusText}`)
        }

        if (!apiResponse.body) {
            throw new Error("API response body is empty")
        }

        res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Connection": "keep-alive",
            "Pragma": "no-cache",
            "Expires": "0",
        })

        // Use pipeline to directly pipe the API's response stream to the client's response stream
        await streamPipeline(apiResponse.body, res)
    } catch (error) {
        console.error("Error:", error)
        res.status(500).json({ error: `Failed to connect to ${apiName} API` })
    }
}
 */
export const crawl4aiCore = async (req: Request, res: Response) => {
    // const decodedUrl = decodeURIComponent(url) // decode the URL
    const apiUrl = `${env.API_CRAWL4AI_URL}/crawl`
    const { urls, priority } = req.body

    // ponytail: the crawler agent egresses on our behalf and nothing downstream
    // blocks private space (no RFC1918 / link-local / metadata guard exists
    // anywhere in this repo), so an unvalidated list here is an internal-read
    // primitive — POST /api/crawl {"urls":["http://169.254.169.254/latest/meta-data/iam/"]}
    // returns the metadata body to the caller. Scheme allowlist + host blocklist
    // is the cheap half; the agent needs the same list re-checked after redirects,
    // which is the half this repo cannot do for it.
    const BLOCKED_HOST = /^(localhost|\.?0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|.*\.local$|.*\.internal$)/i
    const safeUrls = Array.isArray(urls) ?
        urls.filter((candidate: unknown): candidate is string => {
            if (typeof candidate !== "string" || candidate.length > 2048) {
                return false
            }
            try {
                const parsed = new URL(candidate)
                return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
                    !BLOCKED_HOST.test(parsed.hostname)
            } catch {
                return false
            }
        }).slice(0, 50) :
        []

    if (!safeUrls.length) {
        res.status(400).json({ error: "Invalid target URLs" })
        return
    }

    const body = {
        urls: safeUrls,
        priority,
    }

    const headers: JinaHeader = {
        "Authorization": `${req.headers["authorization"] as string || "Bearer "}`,
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


        const buffer = await apiResponse.arrayBuffer()
        res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": buffer.byteLength, // Add Content-Length header
        })

        // await streamPipeline(apiResponse.body, res);
        res.end(Buffer.from(buffer))
    } catch (error) {
        console.error("Error:", error)
        res.status(500).json({ error: "Failed to stream on crawl API" })
    }
}

export const jinaAICrawl = async (req: Request, res: Response) => {
    const url = toSingleParam(req.params.url as string | string[] | undefined)
    const apiKey = env.JINAAI_API_KEY

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
    const apiKey = env.ANTHROPIC_API_KEY
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
    const apiKey = env.OPENAI_API_KEY
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
    const apiKey = env.GROQ_API_KEY
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
