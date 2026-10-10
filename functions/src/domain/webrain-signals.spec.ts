/* eslint-disable max-len */
/**
 * Pins the degradation signal the free scrape path has been reporting unread.
 *
 * The fixtures below are **captured from a running engine** (`webrain mcp
 * --http 9224`) on 2026-10-02, not hand-written — and that matters here,
 * because the nesting is the part that is easy to get wrong. The flags live
 * under `result`; a hand-written fixture would almost certainly have put them
 * at the top level and the test would then have agreed with a wrong parser.
 *
 * The cases that carry the weight are the last three: an absent signal must not
 * read as `false`, and a wrong-typed value must not read as truthy. Getting
 * either wrong turns "this tool does not report needs_js" into "this page is
 * fine", which is exactly the silent failure this signal exists to expose.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {webrainPayloadSignals} from "./webrain-signals.domain"

/** `webrain_scrape` on a static page — the browserless path succeeded. */
const STATIC_PAGE = {
  result: {
    bytes: 713,
    content_type: "text/html; charset=utf-8",
    needs_js: false,
    status: 200,
    text: "<!doctype html><html>…</html>",
    url: "https://example.com",
    visible_chars: 425,
  },
  status: "ok",
}

/** `webrain_scrape` on a 111-byte JS shell — it returned a shell, not content. */
const JS_SHELL = {
  result: {
    needs_js: true,
    status: 200,
    text: "<html>…</html>",
    url: "http://localhost:8099/",
    visible_chars: 3,
  },
  status: "ok",
}

describe("webrainPayloadSignals", () => {
  it("reads the flags a real browserless fetch nests under result", () => {
    const signals = webrainPayloadSignals(STATIC_PAGE)

    assert.equal(signals.needsJs, false)
    assert.equal(signals.visibleChars, 425)
  })

  it("reports needsJs true when the engine got a JS shell", () => {
    const signals = webrainPayloadSignals(JS_SHELL)

    assert.equal(signals.needsJs, true)
    assert.equal(signals.visibleChars, 3)
  })

  it("omits the signal for a tool that does not report it", () => {
    // `extract`, `pdf` and `serp` return a bare payload with no `result` wrapper
    // and no needs_js. Absent must stay absent: `false` would claim the page
    // fetched cleanly over HTTP, which those tools never attempted.
    const signals = webrainPayloadSignals({
      result: {rows: []},
      status: "ok",
    })

    assert.equal(signals.needsJs, undefined)
    assert.equal(signals.visibleChars, undefined)
  })

  it("keeps false distinct from absent", () => {
    const reported = webrainPayloadSignals(STATIC_PAGE)
    const silent = webrainPayloadSignals({status: "ok"})

    assert.equal(reported.needsJs, false)
    assert.equal(silent.needsJs, undefined)
    assert.notEqual(reported.needsJs, silent.needsJs)
  })

  it("does not turn a wrong-typed value into a signal", () => {
    const signals = webrainPayloadSignals({
      result: {needs_js: "yes", visible_chars: "425"},
      status: "ok",
    })

    assert.equal(signals.needsJs, undefined)
    assert.equal(signals.visibleChars, undefined)
  })

  it("survives a payload that is not an object at all", () => {
    for (const payload of [null, undefined, "text", 42, [], {result: []}]) {
      const signals = webrainPayloadSignals(payload)

      assert.equal(signals.needsJs, undefined)
      assert.equal(signals.visibleChars, undefined)
    }
  })

  it("ignores a non-finite visible_chars", () => {
    const signals = webrainPayloadSignals({result: {visible_chars: Infinity}})

    assert.equal(signals.visibleChars, undefined)
  })
})
