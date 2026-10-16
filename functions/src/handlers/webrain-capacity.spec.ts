/* eslint-disable object-curly-spacing */
/**
 * The four CAPACITY tools' argument mappers.
 *
 * These routes exist because `webrain_batch`, `webrain_crawl`,
 * `webrain_download` and `webrain_watch` are advertised by the worker and named
 * in `PAID_ONLY_TOOLS`, but had no route at all -- so `decideWebrainTool` was
 * never asked and the chat could not call them.
 *
 * What is asserted here is the REFUSAL half, because that is the half a mapper
 * owns. The tier and exclusivity answers come from `decideWebrainTool` and
 * `needsExclusiveWorker`, which have their own specs in
 * `domain/webrain-tools.domain.spec.ts`; a mapper that also re-checked the tier
 * would be a second answer to a question already answered once.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  batchArguments,
  crawlArguments,
  downloadArguments,
  watchArguments,
} from "./webrain-tools"

describe("batchArguments", () => {
  const ok = {
    op: "fetch",
    urls: ["https://example.com/a", "https://example.com/b"],
  }

  it("maps op and urls, and echoes the op", () => {
    const mapped = batchArguments(ok)
    assert.equal(mapped.ok, true)
    assert.deepEqual(mapped.ok ? mapped.args : {}, ok)
    assert.equal(mapped.ok ? mapped.echo : undefined, "fetch")
  })

  it("refuses op=eval, which the worker's own enum carries", () => {
    // Arbitrary JavaScript on a process reused across tenants. A lease is
    // exclusive for the CALL, not for the process -- the fact `VAULT_TOOLS` is
    // built on -- so this needs a container of its own.
    for (const op of ["eval", "EVAL"]) {
      assert.equal(
        batchArguments({op, urls: ["https://example.com"]}).ok,
        false,
        op
      )
    }
  })

  it("refuses op=interact, which drives an open page", () => {
    // `webrain_interact` is that tool, and it routes via the caller's machine.
    assert.equal(
      batchArguments({op: "interact", urls: ["https://e.com"]}).ok,
      false
    )
  })

  it("refuses an unknown op and a missing one", () => {
    assert.equal(
      batchArguments({op: "teleport", urls: ["https://e.com"]}).ok,
      false
    )
    assert.equal(batchArguments({urls: ["https://e.com"]}).ok, false)
  })

  it("refuses a private url, and names no partial success", () => {
    // One bad entry refuses the whole call: fetching the other four and
    // answering 200 would be a wrong answer delivered as a success.
    for (const url of [
      "http://127.0.0.1:9222",
      "http://169.254.169.254/latest/meta-data",
      "http://svc.internal/x",
      "file:///etc/passwd",
      "ftp://example.com",
    ]) {
      const mapped = batchArguments({op: "fetch", urls: [url]})
      assert.equal(mapped.ok, false, url)
    }
    assert.equal(
      batchArguments({op: "fetch", urls: ["https://e.com", "http://10.0.0.1"]})
        .ok,
      false
    )
  })

  it("refuses the whole cdp_urls list on one bad entry", () => {
    // The worker round-robins over this list, so dropping an entry would send
    // calls to a browser the caller did not name.
    const mapped = batchArguments({
      ...ok,
      cdp_urls: ["wss://chrome.example.net", "ws://127.0.0.1:9222"],
    })
    assert.equal(mapped.ok, false)
  })

  it("forwards public cdp endpoints, trimmed", () => {
    const mapped = batchArguments({
      ...ok,
      cdp_urls: ["  wss://chrome.example.net  "],
    })
    assert.equal(mapped.ok, true)
    assert.deepEqual(
      mapped.ok ? mapped.args["cdp_urls"] : undefined,
      ["wss://chrome.example.net"]
    )
  })

  it("treats an absent cdp_urls as 'no endpoints', not as a refusal", () => {
    const mapped = batchArguments(ok)
    assert.equal(mapped.ok, true)
    assert.equal(mapped.ok ? "cdp_urls" in mapped.args : true, false)
  })

  it("refuses dir, and an output that is not a bare filename", () => {
    assert.equal(batchArguments({...ok, dir: "/srv/out"}).ok, false)
    for (const output of ["../escape.png", "a/b.png", ""]) {
      assert.equal(batchArguments({...ok, output}).ok, false, output)
    }
    const mapped = batchArguments({...ok, output: "shot.png"})
    assert.equal(mapped.ok, true)
    assert.equal(mapped.ok ? mapped.args["output"] : undefined, "shot.png")
  })

  it("needs a non-empty urls array", () => {
    assert.equal(batchArguments({op: "fetch"}).ok, false)
    assert.equal(batchArguments({op: "fetch", urls: []}).ok, false)
  })
})

describe("crawlArguments", () => {
  it("maps mode and a seed url", () => {
    const mapped = crawlArguments({
      mode: "spider",
      url: "https://example.com",
      max_pages: 5,
    })
    assert.equal(mapped.ok, true)
    // `seed_url`, NOT `url`. Measured against the real worker: `spider` answers
    // "seed_url required" when given a `url`. This assertion previously pinned
    // `url`, which is how a shape-only test passed while the route failed at 2 of
    // the 4 modes.
    assert.deepEqual(mapped.ok ? mapped.args : {}, {
      mode: "spider",
      seed_url: "https://example.com",
      max_pages: 5,
    })
    assert.equal(mapped.ok ? mapped.echo : undefined, "spider")
  })

  it("names the target field each mode actually requires", () => {
    const pick = (x: ReturnType<typeof crawlArguments>) => (x.ok ? x.args : {})

    // spider wants a scalar seed_url; `url` is refused by the worker.
    const spider = pick(crawlArguments({mode: "spider", url: "https://e.com"}))
    assert.equal(spider["seed_url"], "https://e.com")
    assert.equal(spider["url"], undefined)

    // validate wants an ARRAY named urls; a scalar `url` is refused.
    const validate = pick(crawlArguments({mode: "validate", url: "https://e.com"}))
    assert.deepEqual(validate["urls"], ["https://e.com"])
    assert.equal(validate["url"], undefined)

    // sitemap and scan take the scalar url, and accept seed_url too.
    const sitemap = pick(crawlArguments({mode: "sitemap", url: "https://e.com"}))
    assert.equal(sitemap["url"], "https://e.com")
    assert.equal(sitemap["seed_url"], undefined)

    const scan = pick(crawlArguments({mode: "scan", seed_url: "https://e.com"}))
    assert.equal(scan["url"], "https://e.com")
  })

  it("keeps a multi-url list for validate rather than collapsing it", () => {
    const mapped = crawlArguments({
      mode: "validate",
      urls: ["https://a.com", "https://b.com"],
    })
    assert.deepEqual(
      mapped.ok ? mapped.args["urls"] : null,
      ["https://a.com", "https://b.com"]
    )
  })

  it("accepts every mode the worker advertises", () => {
    for (const mode of ["spider", "sitemap", "scan", "validate"]) {
      assert.equal(
        crawlArguments({mode, url: "https://e.com"}).ok,
        true,
        mode
      )
    }
  })

  it("refuses an unknown mode", () => {
    assert.equal(
      crawlArguments({mode: "walk", url: "https://e.com"}).ok,
      false
    )
  })

  it("needs a public target, and refuses a private one", () => {
    assert.equal(crawlArguments({mode: "spider"}).ok, false)
    assert.equal(
      crawlArguments({mode: "spider", url: "http://127.0.0.1"}).ok,
      false
    )
    assert.equal(
      crawlArguments({mode: "sitemap", seed_url: "http://[::1]/x"}).ok,
      false
    )
    assert.equal(
      crawlArguments({mode: "scan", urls: ["https://ok.com", "http://10.1.2.3"]})
        .ok,
      false
    )
  })

  it("refuses crawldir", () => {
    assert.equal(
      crawlArguments({
        mode: "spider",
        url: "https://e.com",
        crawldir: "/srv/crawl",
      }).ok,
      false
    )
  })

  it("refuses an unknown strategy", () => {
    assert.equal(
      crawlArguments({mode: "spider", url: "https://e.com", strategy: "random"})
        .ok,
      false
    )
  })
})

describe("downloadArguments", () => {
  it("refuses args, which are ytdlp's own flag list", () => {
    // Forwarded to a tool that writes files and accepts `--exec`.
    assert.equal(
      downloadArguments({
        urls: ["https://e.com/v"],
        args: ["--exec", "sh -c id"],
      }).ok,
      false
    )
    assert.equal(downloadArguments({urls: ["https://e.com/v"], args: []}).ok,
      false)
  })

  it("maps urls and a known engine, and echoes the first url", () => {
    const mapped = downloadArguments({
      urls: ["https://e.com/v"],
      engine: "ytdlp",
    })
    assert.equal(mapped.ok, true)
    assert.equal(mapped.ok ? mapped.args["engine"] : undefined, "ytdlp")
    assert.equal(mapped.ok ? mapped.echo : undefined, "https://e.com/v")
  })

  it("refuses an unknown engine, dir and a private url", () => {
    assert.equal(
      downloadArguments({urls: ["https://e.com"], engine: "wget"}).ok,
      false
    )
    assert.equal(
      downloadArguments({urls: ["https://e.com"], dir: "/srv"}).ok,
      false
    )
    assert.equal(downloadArguments({urls: ["http://10.0.0.1"]}).ok, false)
    assert.equal(downloadArguments({}).ok, false)
  })
})

describe("watchArguments", () => {
  it("maps a public url and an optional prompt", () => {
    const mapped = watchArguments({url: "https://e.com/v", prompt: "summarise"})
    assert.equal(mapped.ok, true)
    assert.deepEqual(mapped.ok ? mapped.args : {}, {
      url: "https://e.com/v",
      prompt: "summarise",
    })
    assert.equal(mapped.ok ? mapped.echo : undefined, "https://e.com/v")
  })

  it("omits a blank prompt rather than forwarding it", () => {
    const mapped = watchArguments({url: "https://e.com/v", prompt: "   "})
    assert.equal(mapped.ok, true)
    assert.equal(mapped.ok ? "prompt" in mapped.args : true, false)
  })

  it("refuses a private url and a missing one", () => {
    assert.equal(watchArguments({url: "http://[::1]/v"}).ok, false)
    assert.equal(watchArguments({url: "http://169.254.169.254/"}).ok, false)
    assert.equal(watchArguments({}).ok, false)
    assert.equal(watchArguments({url: 9222}).ok, false)
  })
})
