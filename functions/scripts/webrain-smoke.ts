/* eslint-disable no-console */
/**
 * Live smoke test for the deepscrape -> webrain wiring.
 *
 * This is NOT a unit test. It talks to a real worker, so it is a script you run
 * on purpose, against a server you started on purpose:
 *
 *   # terminal 1 - a SHARED, free-tier worker (stateful tooling disabled)
 *   $env:WEBRAIN_HTTP_TOKEN='local-dev-probe-secret'; $env:WEBRAIN_NO_STATE='1'
 *   webrain.exe mcp --http 9333
 *
 *   # terminal 2
 *   $env:WEBRAIN_MCP_URL='http://127.0.0.1:9333'
 *   $env:WEBRAIN_MCP_TOKEN='local-dev-probe-secret'
 *   bunx tsx functions/scripts/webrain-smoke.ts
 *
 * It deliberately prints only status/token/size fields. Tool payloads are
 * target
 * content and can be large or sensitive, so none of it is echoed.
 *
 * `config/env.ts` snapshots `process.env` at import time, which is why the
 * checks
 * live in a function that imports the client AFTER the two variables are set.
 */
import {safeTargetUrls} from "../src/domain/url-guard.domain"

// `config/env.ts` snapshots `process.env` the first time it is imported, and
// that
// import happens inside `main()`. Setting the provider here — at module scope,
// before any of those imports run — is what makes the `/api/crawl` check below
// exercise the webrain branch rather than silently testing the default one.
process.env["SCRAPE_PROVIDER"] = "webrain"

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
const record = (name: string, ok: boolean, detail = ""): void => {
  checks.push({name, ok, detail})
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`
  )
}

const main = async (): Promise<void> => {
  const url = process.env["WEBRAIN_MCP_URL"]
  if (!url) {
    console.error(
      "WEBRAIN_MCP_URL is not set. See this file's header for the run recipe."
    )
    process.exit(2)
  }

  // Imported here, not at the top: the env module reads process.env on first
  // import, so the variables above must already be in place.
  const {webrainHealth, webrainTool} =
    await import("../src/infrastructure/webrain-mcp")

  console.log(`\nwebrain wiring smoke test -> ${url}\n`)

  console.log("transport")
  const health = await webrainHealth()
  record("/health is reachable", health.ok, `status=${health.status}`)

  console.log("\nstateless work (the shared pool's job)")
  // "admin" on purpose: this script probes the WORKER's own guard (does it
  // refuse
  // stateful tools?) and the gateway allowlist would refuse first, making the
  // worker's behaviour unobservable. Admin is the tier the gateway does not
  // filter.
  const scrape = await webrainTool("webrain_scrape", "admin", {
    url: "https://example.com",
  })
  record(
    "webrain_scrape succeeds",
    scrape.ok,
    scrape.ok ? "" : String(scrape.error).slice(0, 120)
  )
  record(
    "the result carries a size stamp",
    typeof scrape.tokens?.est_tokens === "number",
    `est_tokens=${scrape.tokens?.est_tokens} chars=${scrape.tokens?.chars}`
  )
  record(
    "the result parses as JSON",
    scrape.json !== undefined,
    `bytes=${scrape.text.length}`
  )

  console.log("\nstateful work (must be refused on a shared instance)")
  const refused = await webrainTool("webrain_profiles", "admin", {})
  record(
    "webrain_profiles is refused with the no_state error",
    !refused.ok && refused.noStateRefused === true,
    `noStateRefused=${refused.noStateRefused}`
  )

  // The known gap from ADR-2026-09-CRAWL-PROVIDER-ABSTRACTION.md 9a: this
  // reaches
  // the same on-disk profile store but is not in webrain's STATEFUL_TOOLS, so a
  // shared worker serves it. Recorded, not asserted as a pass - it is the
  // reason
  // the gateway needs its own allowlist.
  const gap = await webrainTool("webrain_session", "admin", {op: "list"})
  console.log(
    gap.noStateRefused ?
      "  NOTE  gap CLOSED: webrain_session(op=list) is now refused" :
      "  NOTE  gap OPEN: webrain_session(op=list) is served on a" +
      " shared instance" +
          " => gateway allowlist is load-bearing"
  )

  console.log("\nshared URL guard (the same module ai_handler now uses)")
  const metadata = safeTargetUrls([
    "http://169.254.169.254/latest/meta-data/iam/",
    "http://127.0.0.1:8080/api/orgs",
    "http://10.0.0.5/",
    "file:///etc/passwd",
    "https://example.com/ok",
  ])
  record(
    "only the public https target survives",
    metadata.length === 1 && metadata[0] === "https://example.com/ok",
    `survivors=${metadata.length}`
  )

  console.log(
    "\n/api/crawl on the webrain branch (the route the playground calls)"
  )
  // The real handler, with a minimal Express-Response stand-in. Driving the
  // handler rather than the client is the point: it proves the route + the
  // guard +
  // the provider switch, not just that the worker answers.
  const {webrainCrawl} = await import("../src/handlers/scrape")
  const captured = {status: 0, body: ""}
  const res = {
    status(code: number) {
      captured.status = code
      return res
    },
    json(payload: unknown) {
      captured.body = JSON.stringify(payload)
      return res
    },
  }

  await webrainCrawl(
    // A public target AND a metadata one, so the guard is exercised in the same
    // call.
    {
      body: {
        urls: [
          "https://example.com",
          "http://169.254.169.254/latest/meta-data/",
        ],
      },
    } as never,
    res as never
  )

  const crawl = JSON.parse(captured.body)
  record(
    "the shared guard dropped the metadata target",
    crawl.count === 1,
    `count=${crawl.count}`
  )
  record(
    "the response names the provider",
    crawl.provider === "webrain",
    `provider=${crawl.provider}`
  )
  record("the call succeeded", crawl.status === "ok", `status=${crawl.status}`)
  record(
    "the result carries the worker's typed JSON",
    typeof crawl.results?.[0]?.data === "object",
    `challenge=${JSON.stringify(crawl.results?.[0]?.challenge)}`
  )

  const failed = checks.filter((c) => !c.ok).length
  console.log(`\npass=${checks.length - failed} fail=${failed}\n`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
