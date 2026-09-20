/* eslint-disable object-curly-spacing */
/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable max-len */
/* eslint-disable indent */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { Request, Response, NextFunction } from "express"
import fetch, { RequestInit } from "node-fetch"
import { Buffer } from "node:buffer" // Import Buffer for file handling
import { env } from "../config/env"
// import FormData from "form-data" // Import FormData for handling form data
import { pipeline } from "node:stream"
import { createGunzip } from "node:zlib"

// Only allow UUID-like or alphanumeric-dash-underscore ids (adapt as needed)
const validIdPattern = /^[a-zA-Z0-9_-]{1,64}$/
const toSingleParam = (value: string | string[] | undefined): string =>
    Array.isArray(value) ? (value[0] || "") : (value || "")

// ponytail: normalizeRequestHeaders() was deleted here. Its only caller was
// getMachine, which used it to relay the caller's entire header set to the
// Arachnefly upstream — including `host`, which controls upstream virtual-host
// routing. Do not reintroduce a blanket header relay; build an explicit allowlist.

/**
 * MachinesHandler
 */
class MachinesHandler {
    /**
     * callback
     */
    constructor() {
        // this.upload = multer({ storage: multer.memoryStorage() })
    }

    /**
     * checkImageDeployability
     * @param {*} req
     * @param {*} res
     * @param {*} next
     */
    async checkImageDeployability(req: Request, res: Response, next: NextFunction) {
        const { name } = req.query
        res.type("application/json")

        // ponytail: `decodeURIComponent` throws URIError on malformed input and this
        // ran before the try below, so `?name=%E0` became an unhandled rejection —
        // which Express 4 never routes (see the terminal error handler in server.ts),
        // so no response was written and the request hung to the function timeout.
        // Express has already decoded req.query, so this was a double decode anyway.
        let imageName = ""
        try {
            imageName = typeof name === "string" ? decodeURIComponent(name) : ""
        } catch {
            res.status(400).json({ error: "Invalid image name" })
            return
        }

        if (!imageName) {
            res.status(400).json({ error: "Invalid image name" })
            return
        }

        const token = req.app.locals["user"]
        const apiUrl = env.PRODUCTION === "true"?
        env.API_ARACHNEFLY_URL || "https://arachnefly.fly.dev": "http://localhost:8080"
        const url = new URL(`${apiUrl}/api/check-image`)
        url.searchParams.set("name", imageName)

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
               throw new Error(`${JSON.stringify({code: apiResponse.statusText, internal_message: await apiResponse.json()})}`)
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
            // ponytail: `message: String(error)` used to be returned here, and that
            // string embeds the upstream's entire JSON body ({code,
            // internal_message}) — internal service names, validation rules,
            // sometimes a requestId. Log server-side, never echo to the caller.
            console.warn("API Error:", error)
            res.status(500).json({ error: "check Image API Deployability did not work. try again later" })
        }
    }

    /**
     * getMachine
     * @param {*} req
     * @param {*} res
     * @param {*} next
     */
    async getMachine(req: Request, res: Response, next: NextFunction) {
        const machineId = toSingleParam(req.params.id as string | string[] | undefined)
        res.type("application/json")
        if (!machineId) {
            res.status(400).json({ error: "Missing required parameter: machineId" })
            return
        }

        if (!validIdPattern.test(machineId)) {
            res.status(400).json({ error: "Invalid parameter: machineId" })
            return
        }

        const token = req.app.locals["user"]
        const apiUrl = env.PRODUCTION == "true" ? env.API_ARACHNEFLY_URL || "https://arachnefly.fly.dev" : "http://localhost:8080"
        const url: URL = new URL(`${apiUrl}/api/machine/${machineId}`)
        // ponytail: this used to relay EVERY inbound header to the upstream
        // (normalizeRequestHeaders), which forwarded the caller's `cookie`
        // (_csrf_secret / sid), their `authorization`, and — the exploitable one —
        // their `host`, overriding the upstream's virtual-host routing and turning
        // a fixed-host proxy into an arbitrary-target one. Every sibling method
        // already used the server-held token; this one now does too.
        const headers = {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
        }

        try {
            const fetchOptions: RequestInit = {
                method: "GET",
                headers: headers,
                compress: true,
            }

            const apiResponse = await fetch(url, fetchOptions)

            if (!apiResponse.ok) {
                throw new Error(`${JSON.stringify({code: apiResponse.statusText, internal_message: await apiResponse.json()})}`)
            }

            if (!apiResponse.body) {
                throw new Error("API response body is empty")
            }

            const buffer = await apiResponse.arrayBuffer()
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Content-Length": buffer.byteLength,
            })
            res.end(Buffer.from(buffer))
        } catch (error) {
            console.warn("API Error:", error)
            const details = String(error)
            res.status(500).json({ error: "Failed to get machine details. Please try again later.", message: details })
        }
    }

    /**
     * deployMachine
     * @param {*} req
     * @param {*} res
     * @param {*} next
     */
    async deployMachine(req: Request, res: Response, next: NextFunction) {
        // get region and clone from query parameters
        const { region, clone } = req.query

        // get form data from request
        const body = req.body
        // const files = req.files
        res.type("application/json")
        if (!region || !clone || !body) {
            res.status(400).json({ error: "Missing required parameters: region or clone or body" })
            return
        }

        // get tken from request include in locals
        const token = req.app.locals["user"]
        const apiUrl = env.PRODUCTION == "true" ? env.API_ARACHNEFLY_URL || "https://arachnefly.fly.dev" : "http://localhost:8080"

        // const authHeader = req.headers["api-key"] as string
        // eslint-disable-next-line prefer-const
        let url: URL = new URL(`${apiUrl}/api/deploy`)
        url.searchParams.set("region", region as string)
        url.searchParams.set("clone", clone as string)


        //  // Rebuild FormData for forwarding
        // const form = new FormData()

        // // Add fields
        // for (const [key, value] of Object.entries(body)) {
        //     form.append(key, value)
        // }

        // Add files
        // if (Array.isArray(files)) {
        //     for (const file of files) {
        //         form.append(file.fieldname, file.buffer, {
        //             filename: file.originalname,
        //             contentType: file.mimetype,
        //         })
        //     }
        // }

        const headers = {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
        }

        try {
            const fetchOptions: RequestInit = {
                method: "POST",
                body: JSON.stringify(body),
                headers,
                compress: true,
                // compress: true,
            }

            // ponytail: two console.log calls were deleted here.
            //   console.log("Fetch body:", body)    — logged the entire deploy
            //     payload, which routinely carries machine env vars and registry
            //     credentials, into Cloud Logging (retained, readable by any
            //     logging.viewer).
            //   console.log("API URL:", url.toString()) — leaked the internal
            //     upstream base URL and its parameters.
            // If you need a trace, log an allowlisted projection.

            const apiResponse = await fetch(url, fetchOptions)

            if (!apiResponse.ok) {
                throw new Error(`${JSON.stringify({code: apiResponse.statusText, internal_message: await apiResponse.json()})}`)
            }

            if (!apiResponse.body) {
                throw new Error("API response body is empty")
            }

            const buffer = await apiResponse.arrayBuffer()
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Content-Length": buffer.byteLength, // Add Content-Length header
            })
            // await streamPipeline(apiResponse.body, res)
            res.end(Buffer.from(buffer))
        } catch (error) {
            // ponytail: `message: String(error)` removed — it carried the upstream's
            // whole JSON error body to the caller. Logged server-side only now.
            console.warn("------------------- API Error:", error)
            res.status(500).json({ error: "Failed to deploy machine. Please try again later." })
        }
    }

    /**
     * waitForState
     * @param {*} req
     * @param {*} res
     * @param {*} next
     */
    async waitForState(req: Request, res: Response, next: NextFunction) {
        const machineId = toSingleParam(req.params.machineId as string | string[] | undefined)
        // Validate machineId: allow only alphanumeric, dash, and underscore (change regex as needed for your IDs)
        if (!machineId || !/^[a-zA-Z0-9_-]+$/.test(machineId)) {
            res.status(400).json({ error: "Invalid machineId format." })
            return
        }
        // eslint-disable-next-line camelcase
        const { instance_id, state, timeout } = req.query
        res.type("application/json")
        // eslint-disable-next-line camelcase
        if (!machineId || !instance_id || !state) {
            res.status(400).json({ error: "Missing required parameters: machineId, instance_id, or state" })
            return
        }

        const token = req.app.locals["user"]
        const apiUrl = env.PRODUCTION == "true" ? env.API_ARACHNEFLY_URL || "https://arachnefly.fly.dev" : "http://localhost:8080"
        const url: URL = new URL(`${apiUrl}/api/machine/waitforstate/${machineId}`)

        url.searchParams.set("state", state as string)
        // eslint-disable-next-line camelcase
        url.searchParams.set("instance_id", instance_id as string)
        if (timeout) url.searchParams.set("timeout", timeout as string)

        const headers = {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
        }

        try {
            const fetchOptions: RequestInit = {
                method: "GET",
                headers: headers,
                compress: true,
            }

            const apiResponse = await fetch(url, fetchOptions)

            if (!apiResponse.ok) {
                throw new Error(`${JSON.stringify({code: apiResponse.statusText, internal_message: await apiResponse.json()})}`)
            }

            if (!apiResponse.body) {
                throw new Error("API response body is empty")
            }

            const buffer = await apiResponse.arrayBuffer()
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Content-Length": buffer.byteLength,
            })
            res.end(Buffer.from(buffer))
        } catch (error) {
            console.warn("API Error:", error)
            const details = String(error)
            res.status(500).json({ error: "Failed to wait for machine state. Please try again later.", message: details })
        }
    }

    /**
     * startMachine
     * @param {*} req
     * @param {*} res
     */
    async startMachine(req: Request, res: Response) {
        const machineId = toSingleParam(req.params.machineId as string | string[] | undefined)
        res.type("application/json")
        // Only allow machine IDs that are alphanumeric, dash or underscore (adjust pattern as needed)
        const SAFE_MACHINE_ID_REGEX = /^[a-zA-Z0-9_-]+$/
        if (!machineId) {
            res.status(400).json({ error: "Missing required parameter: machineId" })
            return
        }
        if (!SAFE_MACHINE_ID_REGEX.test(machineId)) {
            res.status(400).json({ error: "Invalid parameter: machineId" })
            return
        }

        const token = req.app.locals["user"]
        const apiUrl = env.PRODUCTION == "true" ?
            env.API_ARACHNEFLY_URL || "https://arachnefly.fly.dev" : "http://localhost:8080"


        const url: URL = new URL(`${apiUrl}/api/machine/${machineId}/start`)
        const headers = {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
        }

        try {
            const fetchOptions: RequestInit = {
                method: "PUT",
                headers: headers,
                compress: true,
            }

            const apiResponse = await fetch(url, fetchOptions)

            if (!apiResponse.ok) {
                throw new Error(`${JSON.stringify({code: apiResponse.statusText, internal_message: await apiResponse.json()})}`)
            }

            if (!apiResponse.body) {
                throw new Error("API response body is empty")
            }

            const buffer = await apiResponse.arrayBuffer()
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Content-Length": buffer.byteLength,
            })
            res.end(Buffer.from(buffer))
        } catch (error) {
            console.warn("API Error:", error)
            const details = String(error)
            res.status(500).json({ error: "Failed to destroy machine. Please try again later.", message: details })
        }
    }

    /**
     * suspendMachine
     * @param {*} req
     * @param {*} res
     */
    async suspendMachine(req: Request, res: Response) {
        const machineId = toSingleParam(req.params.machineId as string | string[] | undefined)
        res.type("application/json")
        // Only allow UUID-like or alphanumeric-dash-underscore ids (adapt as needed)
        const validIdPattern = /^[a-zA-Z0-9_-]{1,64}$/
        if (!machineId) {
            res.status(400).json({ error: "Missing required parameter: machineId" })
            return
        }
        if (!validIdPattern.test(machineId)) {
            res.status(400).json({ error: "Invalid machineId format" })
            return
        }

        const token = req.app.locals["user"]
        const apiUrl = env.PRODUCTION == "true" ?
            env.API_ARACHNEFLY_URL || "https://arachnefly.fly.dev" : "http://localhost:8080"

        const url: URL = new URL(`${apiUrl}/api/machine/${machineId}/suspend`)
        const headers = {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
        }
        try {
            const fetchOptions: RequestInit = {
                method: "PUT",
                headers: headers,
                compress: true,
            }

            const apiResponse = await fetch(url, fetchOptions)

            if (!apiResponse.ok) {
                throw new Error(`${JSON.stringify({code: apiResponse.statusText, internal_message: await apiResponse.json()})}`)
            }

            if (!apiResponse.body) {
                throw new Error("API response body is empty")
            }

            const buffer = await apiResponse.arrayBuffer()
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Content-Length": buffer.byteLength,
            })
            res.end(Buffer.from(buffer))
        } catch (error) {
            console.warn("API Error:", error)
            const details = String(error)
            res.status(500).json({ error: "Failed to destroy machine. Please try again later.", message: details })
        }
    }

    /**
     * stopMachine
     * @param {*} req
     * @param {*} res
     */
    async stopMachine(req: Request, res: Response) {
        const machineId = toSingleParam(req.params.machineId as string | string[] | undefined)
        res.type("application/json")
        if (!validIdPattern.test(machineId)) {
            res.status(400).json({ error: "Invalid machineId format" })
            return
        }
        if (!machineId) {
            res.status(400).json({ error: "Missing required parameter: machineId" })
            return
        }
        const token = req.app.locals["user"]
        const apiUrl = env.PRODUCTION == "true" ?
            env.API_ARACHNEFLY_URL || "https://arachnefly.fly.dev" : "http://localhost:8080"

        const url: URL = new URL(`${apiUrl}/api/machine/${machineId}/stop`)
        const headers = {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
        }
        try {
            const fetchOptions: RequestInit = {
                method: "PUT",
                headers: headers,
                compress: true,
            }

            const apiResponse = await fetch(url, fetchOptions)

            if (!apiResponse.ok) {
                throw new Error(`${JSON.stringify({code: apiResponse.statusText, internal_message: await apiResponse.json()})}`)
            }

            if (!apiResponse.body) {
                throw new Error("API response body is empty")
            }

            const buffer = await apiResponse.arrayBuffer()
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Content-Length": buffer.byteLength,
            })
            res.end(Buffer.from(buffer))
        } catch (error) {
            console.warn("API Error:", error)
            const details = String(error)
            res.status(500).json({ error: "Failed to destroy machine. Please try again later.", message: details })
        }
    }

    /**
     * destroyMachine
     * @param {*} req
     * @param {*} res
     */
    async destroyMachine(req: Request, res: Response) {
        const machineId = toSingleParam(req.params.machineId as string | string[] | undefined)
        // Same undefined-`req.query` hazard as buildGuestAcquisition: the Express 4 app
        // is handed a request built by the framework's Express 5 app.
        const force: boolean = req.query?.force === "true"
        res.type("application/json")
        // Add same validation as stopMachine
        if (!machineId) {
            res.status(400).json({ error: "Missing required parameter: machineId" })
            return
        }
        if (!validIdPattern.test(machineId)) {
            res.status(400).json({ error: "Invalid machineId format" })
            return
        }

        const token = req.app.locals["user"]
        const apiUrl = env.PRODUCTION == "true" ?
            env.API_ARACHNEFLY_URL || "https://arachnefly.fly.dev" : "http://localhost:8080"
        const url: URL = new URL(`${apiUrl}/api/machine/${machineId}`)
        url.searchParams.set("force", force.toString())

        const headers = {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
        }

        try {
            const fetchOptions: RequestInit = {
                method: "DELETE",
                headers: headers,
                compress: true,
            }

            const apiResponse = await fetch(url, fetchOptions)

            if (!apiResponse.ok) {
                throw new Error(`${JSON.stringify({code: apiResponse.statusText, internal_message: await apiResponse.json()})}`)
            }

            if (!apiResponse.body) {
                throw new Error("API response body is empty")
            }

            const buffer = await apiResponse.arrayBuffer()
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Content-Length": buffer.byteLength,
            })
            res.end(Buffer.from(buffer))
        } catch (error) {
            const details = String(error)
            console.warn("API Error:", details)
            res.status(500).json({ error: "Failed to destroy machine. Please try again later.", message: details })
        }
    }
}
const arachnefly = new MachinesHandler()
export { arachnefly }
