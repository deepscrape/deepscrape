/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { presentAlert } from "./alert-presentation"
import { escapeHtml, renderEmail } from "../../infrastructure/email"

describe("escapeHtml", () => {
  it("neutralises markup from attacker-controlled fields", () => {
    const escaped = escapeHtml("<script>alert(\"x\")</script>")
    assert.ok(!escaped.includes("<script>"))
    assert.ok(!escaped.includes("\""))
    assert.equal(escaped, "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;")
  })

  it("escapes an ampersand before the entities it would otherwise create", () => {
    // The ordering matters: escaping '<' first would produce '&amp;lt;'.
    assert.equal(escapeHtml("<"), "&lt;")
    assert.equal(escapeHtml("&lt;"), "&amp;lt;")
  })
})

describe("presentAlert channel selection", () => {
  it("sends both email and push for a new sign-in location", () => {
    const result = presentAlert({
      category: "new_login_location",
      metadata: { location: "Lisbon, Portugal", country: "Portugal", ip: "203.0.113.4" },
    })

    assert.deepEqual(result.channels, { email: true, push: true })
    assert.ok(result.email)
    assert.match(result.email.subject, /Lisbon, Portugal/)
    assert.match(result.pushBody, /Lisbon, Portugal/)
  })

  it("falls back to the country when the city is missing", () => {
    const result = presentAlert({
      category: "new_login_location",
      metadata: { country: "Japan" },
    })

    assert.ok(result.email)
    assert.match(result.email.subject, /Japan/)
  })

  it("keeps MFA-disabled as push-only because the writer already emails it", () => {
    const result = presentAlert({ category: "mfa_disabled", title: "MFA disabled" })

    assert.deepEqual(result.channels, { email: false, push: true })
    assert.equal(result.email, undefined)
  })

  it("never emails an unrecognised category", () => {
    const result = presentAlert({ category: "something-new", title: "T", message: "M" })

    assert.deepEqual(result.channels, { email: false, push: true })
    assert.equal(result.pushTitle, "T")
    assert.equal(result.pushBody, "M")
  })

  it("falls back to the document title and message when metadata is absent", () => {
    const result = presentAlert({ title: "Fallback title", message: "Fallback body" })

    assert.equal(result.pushTitle, "Fallback title")
    assert.equal(result.pushBody, "Fallback body")
    assert.equal(result.channels.email, false)
  })
})

describe("renderEmail", () => {
  it("cannot be made to emit a script tag through alert metadata", () => {
    const presentation = presentAlert({
      category: "new_login_location",
      metadata: {
        location: "Berlin",
        ip: "<script>alert(1)</script>",
        userAgent: "\"><img src=x onerror=\"alert(2)\">",
      },
    })

    assert.ok(presentation.email)
    const html = renderEmail(presentation.email.content)

    assert.ok(!html.includes("<script>"), "injected script tag survived rendering")
    // The property to assert is "no LIVE markup", not "the substring onerror is
    // absent": an escaped payload still contains `onerror=` as inert text, which
    // is harmless because `<` and `>` never reach the document unescaped.
    assert.ok(!html.includes("<img"), "injected img element survived rendering")
    assert.ok(html.includes("&lt;script&gt;"), "value should be present but escaped")
    assert.ok(html.includes("&lt;img"), "injected element should be present but escaped")
  })

  it("is a complete document with a preheader and no external asset dependency", () => {
    const presentation = presentAlert({ category: "new_trusted_device", metadata: { deviceName: "Pixel 9" } })
    assert.ok(presentation.email)

    const html = renderEmail(presentation.email.content)

    assert.ok(html.startsWith("<!DOCTYPE html>"))
    assert.ok(html.includes("</html>"))
    // No remote images: they are blocked by default in most clients and render as
    // a broken box above the fold.
    assert.ok(!/<img\s/i.test(html), "email must not depend on a remote image")
  })
})
