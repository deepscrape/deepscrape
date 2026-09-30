/* eslint-disable indent */
/* eslint-disable object-curly-spacing */
/* eslint-disable max-len */

import { pipeline } from "node:stream"
import { createGunzip } from "node:zlib"
import fetch, { RequestInit } from "node-fetch"
import { Request, Response } from "express"
import { crawlAgentBaseUrl } from "../config/upstreams"

/**
 * CrawlerHandler
 */
class CrawlerHandler {
    /**
     * callback
     */
    constructor() {
        // this.upload = multer({ storage: multer.memoryStorage() })
    }

    /**
     * getTempTaskId
     * @param {*} req
     * @param {*} res
     */
    async getTempTaskId(req: Request, res: Response) {
        // const decodedUrl = decodeURIComponent(url) // decode the UR
        // res.type("application/json")

        // CORRECTED: this deliberately relays the CALLER's token, not a server
        // secret. The target is `crawlagent` (github.com/deepscrape/crawlagent) —
        // a FastAPI job service whose job routes are all `Depends(verify_token)`.
        // It verifies the caller's Firebase ID token and derives `uid` from it
        // (`uid = decoded_token.get("uid")`) to write `users/{uid}/operations`, so
        // a server-held secret would break the ownership path. The token is read
        // per-REQUEST from `req.authToken`; it used to come from `req.app.locals`,
        // which is the application's object and therefore shared across requests.
        const token = req.authToken
        const apiUrl = crawlAgentBaseUrl()
        const url = new URL(`${apiUrl}/crawl/job/temp-task-id`)

        const headers = {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
        }

        try {
            const fetchOptions: RequestInit = {
                method: "GET",
                headers,
            }

            const apiResponse = await fetch(url, fetchOptions)

            if (!apiResponse.ok) {
                throw new Error(`${JSON.stringify({ code: apiResponse.statusText, internal_message: await apiResponse.json() })}`)
            }

            if (!apiResponse.body) {
                throw new Error("API response body is empty")
            }

            const contentEncoding = apiResponse.headers.get("content-encoding")
            console.log("Backend response status:", apiResponse.status, "Content-Encoding:", contentEncoding)
            res.setHeader("Content-Type", "application/json") // text/event-stream
            // res.end(await apiResponse.json())
            // if (contentEncoding === "gzip") {
            //     pipeline(
            //         apiResponse.body,
            //         createGunzip(),
            //         res,
            //         (err) => {
            //             if (err && !res.headersSent) {
            //                 res.writeHead(500, { "Content-Type": "text/plain" })
            //                 res.end("Pipeline error")
            //             }
            //         }
            //     )
            // } else {
            pipeline(
                apiResponse.body,
                res,
                (err) => {
                    if (err && !res.headersSent) {
                        res.writeHead(500, { "Content-Type": "text/plain" })
                        res.end("Pipeline error")
                    }
                }
            )
            // }
        } catch (error) {
            console.warn("API Error:", error)
            const details = String(error)
            res.status(500).json({ error: "Cannot get temporary TaskId. try again later", message: details })
        }
    }

    /**
     * getTaskId
     * @param {*} req
     * @param {*} res
     */
    async getTaskId(req: Request, res: Response) {
        // const decodedUrl = decodeURIComponent(url) // decode the UR
        const { tempTaskId } = req.params
        if (!tempTaskId) {
            res.status(400).json({ error: "Missing URL parameter", message: "Please provide a temporary TaskId" })
            return
        }

        res.type("application/json")

        const token = req.authToken
        const apiUrl = crawlAgentBaseUrl()
        const url = new URL(`${apiUrl}/crawl/job/${tempTaskId}`)

        const headers = {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
        }

        try {
            const fetchOptions: RequestInit = {
                method: "GET",
                headers,
            }

            const apiResponse = await fetch(url, fetchOptions)

            if (!apiResponse.ok) {
                throw new Error(`${JSON.stringify({ code: apiResponse.statusText, internal_message: await apiResponse.json() })}`)
            }

            if (!apiResponse.body) {
                throw new Error("API response body is empty")
            }

            const contentEncoding = apiResponse.headers.get("content-encoding")
            res.setHeader("Content-Type", "application/json")

            if (contentEncoding === "gzip") {
                pipeline(
                    apiResponse.body,
                    createGunzip(),
                    res,
                    (err) => {
                        if (err && !res.headersSent) {
                            res.writeHead(500, { "Content-Type": "text/plain" })
                            res.end("Pipeline error")
                        }
                    }
                )
            } else {
                pipeline(
                    apiResponse.body,
                    res,
                    (err) => {
                        if (err && !res.headersSent) {
                            res.writeHead(500, { "Content-Type": "text/plain" })
                            res.end("Pipeline error")
                        }
                    }
                )
            }
        } catch (error) {
            console.warn("API Error:", error)
            const details = String(error)
            res.status(500).json({ error: "Cannot Get TaskId. try again later", message: details })
        }
    }

    /**
     * getTaskStatus
     * @param {*} req
     * @param {*} res
     */
    async getTaskStatus(req: Request, res: Response) {
        const { taskId } = req.params
        if (!taskId) {
            res.status(400).json({ error: "Missing URL parameter", message: "Please provide a TaskId" })
            return
        }

        const token = req.authToken
        const apiUrl = crawlAgentBaseUrl()
        const url = new URL(`${apiUrl}/crawl/stream/job/status/${taskId}`)

        const headers = {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }

        try {
            const fetchOptions: RequestInit = {
                method: "GET",
                headers,
            }

            const apiResponse = await fetch(url, fetchOptions)

            if (!apiResponse.ok) {
                throw new Error(`${JSON.stringify({ code: apiResponse.statusText, internal_message: await apiResponse.json() })}`)
            }

            if (!apiResponse.body) {
                throw new Error("API response body is empty")
            }

            // Set SSE headers
            res.setHeader("Content-Type", "text/event-stream")
            res.setHeader("Cache-Control", "no-cache")
            res.setHeader("Connection", "keep-alive")

            // Directly pipe the SSE stream
            pipeline(
                apiResponse.body,
                res,
                (err) => {
                    if (err && !res.headersSent) {
                        res.writeHead(500, { "Content-Type": "text/plain" })
                        res.end("Pipeline error")
                    }
                }
            )
        } catch (error) {
            console.warn("API Error:", error)
            const details = String(error)
            res.status(500).json({ error: "Cannot Get Tasks Status with given TaskId. try again later", message: details })
        }
    }

    /**
     * streamTaskResults
     * @param {*} req
     * @param {*} res
     */
    async streamTaskResults(req: Request, res: Response) {
        const { taskId } = req.params
        if (!taskId) {
            res.status(400).json({ error: "Missing URL parameter", message: "Please provide a TaskId" })
            return
        }

        const token = req.authToken
        const apiUrl = crawlAgentBaseUrl()
        const url = new URL(`${apiUrl}/crawl/stream/job/${taskId}`)

        const headers = {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }

        try {
            const fetchOptions: RequestInit = {
                method: "GET",
                headers,
            }

            const apiResponse = await fetch(url, fetchOptions)

            if (!apiResponse.ok) {
                throw new Error(`${JSON.stringify({ code: apiResponse.statusText, internal_message: await apiResponse.json() })}`)
            }

            if (!apiResponse.body) {
                throw new Error("API response body is empty")
            }

            // Set SSE headers
            res.setHeader("Content-Type", "text/event-stream")
            res.setHeader("Cache-Control", "no-cache")
            res.setHeader("Connection", "keep-alive")

            // Directly pipe the SSE stream
            pipeline(
                apiResponse.body,
                res,
                (err) => {
                    if (err && !res.headersSent) {
                        res.writeHead(500, { "Content-Type": "text/plain" })
                        res.end("Pipeline error")
                    }
                }
            )
        } catch (error) {
            console.warn("API Error:", error)
            const details = String(error)
            res.status(500).json({ error: "Cannot Get Crawl Results with given TaskId. try again later", message: details })
        }
    }

    /**
     * cancelTask
     * @param {*} req
     * @param {*} res
     */
    async cancelTask(req: Request, res: Response) {
        // const decodedUrl = decodeURIComponent(url) // decode the UR
        const { tempTaskId } = req.params
        if (!tempTaskId) {
            res.status(400).json({ error: "Missing URL parameter", message: "Please provide a temporary TaskId" })
            return
        }

        res.type("application/json")

        const token = req.authToken
        const apiUrl = crawlAgentBaseUrl()
        const url = new URL(`${apiUrl}/crawl/job/${tempTaskId}/cancel`)

        const headers = {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
        }

        try {
            const fetchOptions: RequestInit = {
                method: "PUT",
                headers,
            }

            const apiResponse = await fetch(url, fetchOptions)

            if (!apiResponse.ok) {
                throw new Error(`${JSON.stringify({ code: apiResponse.statusText, internal_message: await apiResponse.json() })}`)
            }

            if (!apiResponse.body) {
                throw new Error("API response body is empty")
            }

            const contentEncoding = apiResponse.headers.get("content-encoding")
            res.setHeader("Content-Type", "application/json")

            if (contentEncoding === "gzip") {
                pipeline(
                    apiResponse.body,
                    createGunzip(),
                    res,
                    (err) => {
                        if (err && !res.headersSent) {
                            res.writeHead(500, { "Content-Type": "text/plain" })
                            res.end("Pipeline error")
                        }
                    }
                )
            } else {
                pipeline(
                    apiResponse.body,
                    res,
                    (err) => {
                        if (err && !res.headersSent) {
                            res.writeHead(500, { "Content-Type": "text/plain" })
                            res.end("Pipeline error")
                        }
                    }
                )
            }
        } catch (error) {
            console.warn("API Error:", error)
            const details = String(error)
            res.status(500).json({ error: "Cannot Get TaskId. try again later", message: details })
        }
    }


    /**
     * multiCrawlEnqueue
     * @param {*} req
     * @param {*} res
     */
    async multiCrawlEnqueue(req: Request, res: Response) {
        // const decodedUrl = decodeURIComponent(url) // decode the UR
        res.type("application/json")

        // eslint-disable-next-line camelcase
        // const {urls, temp_task_id, operation_data, ..configs} = req.body

        // TODO: need validation here
        const payload = req.body

        if (!payload) {
            res.status(400).json({ error: "Invalid request body", message: "Please provide an array of jobs" })
            return
        }

        const token = req.authToken
        const apiUrl = crawlAgentBaseUrl()
        const url = new URL(`${apiUrl}/crawl/stream/job`)

        const headers = {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

        try {
            const fetchOptions: RequestInit = {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
            }

            const apiResponse = await fetch(url, fetchOptions)

            if (!apiResponse.ok) {
                throw new Error(`${JSON.stringify({ code: apiResponse.statusText, internal_message: await apiResponse.json() })}`)
            }

            if (!apiResponse.body) {
                throw new Error("API response body is empty")
            }

            const contentEncoding = apiResponse.headers.get("content-encoding")
            res.setHeader("Content-Type", "application/json")

            if (contentEncoding === "gzip") {
                pipeline(
                    apiResponse.body,
                    createGunzip(),
                    res,
                    (err) => {
                        if (err && !res.headersSent) {
                            res.writeHead(500, { "Content-Type": "text/plain" })
                            res.end("Pipeline error")
                        }
                    }
                )
            } else {
                pipeline(
                    apiResponse.body,
                    res,
                    (err) => {
                        if (err && !res.headersSent) {
                            res.writeHead(500, { "Content-Type": "text/plain" })
                            res.end("Pipeline error")
                        }
                    }
                )
            }
        } catch (error) {
            console.warn("API Error:", error)
            const details = String(error)
            res.status(500).json({ error: "Cannot enqueue multiple Crawl Jobs. try again later", message: details })
        }
    }
}


const crawlagent = new CrawlerHandler()

export { crawlagent }
