/* eslint-disable object-curly-spacing */
/**
 * The ACCEPT path of the QStash signature check, proven against a real
 * delivery.
 *
 * Why this exists
 * ---------------
 * `qstash.spec.ts` pins the REJECT path — that an absent or forged signature is
 * refused. It cannot pin the accept path, because building a valid Upstash JWS
 * by hand means reimplementing their format, and a test that agrees with my own
 * guess proves nothing about theirs.
 *
 * So this does the real thing: it publishes through `publishCrawlTarget` to a
 * locally running `qstash-cli dev`, which signs the delivery with its own key,
 * and then verifies the signature that actually arrives. A verifier that
 * refused EVERYTHING would pass every offline test and fail here — which is the
 * whole reason this file exists.
 *
 * It deliberately avoids the BFF, Firestore and webrain: the question is
 * whether a genuine signature verifies, and nothing else.
 *
 * Run
 * ---
 *   # terminal 1 — leave running
 *   npx @upstash/qstash-cli@latest dev -port=8090 -log-port=8091
 *
 *   # terminal 2 — the four values are the dev server's FIXED constants,
 *   # printed on every run, identical on every machine, and NOT secrets.
 *   # The production ones are real; these are not.
 *   $env:QSTASH_URL="http://127.0.0.1:8090"
 *   $env:QSTASH_TOKEN="<the long token the server printed>"
 *   $env:QSTASH_CURRENT_SIGNING_KEY="sig_7kYjw48mhY7kAjqNGcy6cr29RJ6r"
 *   $env:QSTASH_NEXT_SIGNING_KEY="sig_5ZB6DVzB1wjE8S6rZ7eenA8Pdnhs"
 *   $env:APP_ORIGIN="http://127.0.0.1:8099"
 *   bun x tsx scripts/qstash-verify-smoke.ts
 */
import { createServer } from "node:http"
import {
  publishCrawlTarget,
  verifyQstashDelivery,
} from "../src/infrastructure/qstash"

const PORT = 8099
const HOST = "127.0.0.1"

/** Set by the promise below, called once a delivery has been checked. */
let resolveDelivery!: (verified: boolean) => void

const delivered = new Promise<boolean>((resolve) => {
  resolveDelivery = resolve
})

/**
 * Captures one delivery and verifies it, exactly as the BFF route does.
 *
 * The body is reassembled from raw chunks rather than read as text through a
 * framework: the signature covers the exact bytes, so anything that re-parses
 * and re-serialises would invalidate it before the check.
 * @param {*} request The incoming delivery.
 * @param {*} response Answered so QStash records a success, not a retry.
 */
const capture = (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse
): void => {
  const chunks: Buffer[] = []

  request.on("data", (chunk: Buffer) => chunks.push(chunk))

  request.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf8")
    const signature = String(request.headers["upstash-signature"] ?? "")
    const url = `http://${HOST}:${PORT}${request.url ?? "/"}`

    resolveDelivery(await verifyQstashDelivery(raw, signature, url))

    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ ok: true }))
  })
}

const server = createServer(capture)

/** Fails the run rather than hanging if the delivery never arrives. */
const timeout = new Promise<boolean>((resolve) =>
  setTimeout(() => {
    resolve(false)
  }, 15_000)
)

/**
 * Publishes one message, waits for the delivery, and sets the exit code.
 * @return {*} Nothing.
 */
async function main(): Promise<void> {
  try {
    await new Promise<void>((resolve) =>
      server.listen(PORT, HOST, () => resolve())
    )

    const messageId = await publishCrawlTarget({
      taskId: "smoke-1",
      uid: "smoke-user",
      url: "https://example.com",
      accessMode: "plan",
    })

    console.log(`published ${messageId}, waiting for the delivery`)

    const verified = await Promise.race([delivered, timeout])

    console.log(
      verified ?
        "PASS: a real QStash delivery's signature verified" :
        "FAIL: no delivery arrived, or its signature did not verify"
    )
    process.exitCode = verified ? 0 : 1
  } finally {
    server.close()
  }
}

main().catch((error: unknown) => {
  console.error("FAIL:", error)
  process.exitCode = 1
})
