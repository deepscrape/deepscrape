import {strict as assert} from "node:assert"
import {describe, it} from "node:test"
import {vaultArguments} from "./webrain-tools"

// The vault mapper is the boundary between the UI and a WORKER-HELD credential
// store, so two things matter beyond field plumbing: that only the five vault
// ops are reachable, and that `login`'s url goes past the target guard rather
// than being forwarded to a worker to navigate.

describe("vaultArguments", () => {
  it("refuses a missing op", () => {
    const mapped = vaultArguments({})
    assert.equal(mapped.ok, false)
  })

  it("refuses a session op that is not a vault op", () => {
    // `open`/`close`/`list`/`cookies` are webrain_session ops too, but they
    // belong to the lease routes, not here.
    const mapped = vaultArguments({op: "open"})
    assert.equal(mapped.ok, false)
    assert.match(
      mapped.ok ? "" : mapped.error,
      /expected one of profiles, login, save_state/
    )
  })

  it("lists the vault with no arguments at all", () => {
    const mapped = vaultArguments({op: "profiles"})
    assert.equal(mapped.ok, true)
    assert.deepEqual(mapped.ok ? mapped.args : {}, {op: "profiles"})
  })

  it("does not send a port to profiles", () => {
    // The worker ignores a port on `profiles`; sending it is an argument that
    // looks accepted and does nothing.
    const mapped = vaultArguments({op: "profiles", port: 9222})
    assert.equal(mapped.ok, true)
    assert.equal(mapped.ok ? "port" in mapped.args : true, false)
  })

  it("needs service and profile for the entry ops", () => {
    const missingProfile = vaultArguments({op: "save_state", service: "github"})
    assert.equal(missingProfile.ok, false)
    assert.match(
      missingProfile.ok ? "" : missingProfile.error,
      /needs a profile/
    )

    const missingService = vaultArguments({op: "close_launch", profile: "me"})
    assert.equal(missingService.ok, false)
    assert.match(
      missingService.ok ? "" : missingService.error,
      /needs a service/
    )
  })

  it("carries service, profile and an explicit port", () => {
    const mapped = vaultArguments({
      op: "restore_state",
      service: "github",
      profile: "me",
      port: 9222,
    })
    assert.equal(mapped.ok, true)
    assert.deepEqual(mapped.ok ? mapped.args : {}, {
      op: "restore_state",
      service: "github",
      profile: "me",
      port: 9222,
    })
  })

  it("refuses a login with no url", () => {
    const mapped = vaultArguments({
      op: "login",
      service: "github",
      profile: "me",
    })
    assert.equal(mapped.ok, false)
    assert.match(mapped.ok ? "" : mapped.error, /needs an http\(s\) url/)
  })

  it("refuses a login url that is a private address", () => {
    // The same trust boundary /scrape crosses: a caller-supplied address handed
    // to a worker to navigate.
    const mapped = vaultArguments({
      op: "login",
      service: "github",
      profile: "me",
      url: "http://127.0.0.1/admin",
    })
    assert.equal(mapped.ok, false)
  })

  it("accepts a public login url and echoes the op", () => {
    const mapped = vaultArguments({
      op: "login",
      service: "github",
      profile: "me",
      url: "https://github.com/login",
    })
    assert.equal(mapped.ok, true)
    assert.equal(mapped.ok ? mapped.echo : undefined, "login")
    assert.equal(
      mapped.ok ? mapped.args["url"] : undefined,
      "https://github.com/login"
    )
  })

  // The cookie pair is what makes a login movable TODAY: both ends are already
  // payload-based on the worker, unlike save_state/restore_state.
  it("lists cookies with no arguments at all", () => {
    const mapped = vaultArguments({op: "cookies"})
    assert.equal(mapped.ok, true)
    assert.deepEqual(mapped.ok ? mapped.args : {}, {op: "cookies"})
  })

  it("forwards the caller's own browser for the cookie pair", () => {
    const mapped = vaultArguments({
      op: "cookies",
      cdp_url: "  wss://chrome.example.net  ",
    })
    assert.equal(mapped.ok, true)
    assert.equal(
      mapped.ok ? mapped.args["cdp_url"] : undefined,
      "wss://chrome.example.net",
      "trimmed, and the only argument the cookie ops need",
    )
  })

  it("refuses an endpoint it cannot use instead of dropping it", () => {
    // Dropping it would run the caller against the platform's own browser while
    // they believe it is theirs, and the jar they read would be that pooled
    // worker's browser. A 400 is the honest answer.
    for (const endpoint of [
      "ws://127.0.0.1:9222",
      "wss://user:secret@chrome.example.net",
      "ftp://chrome.example.net",
      9222,
    ]) {
      const mapped = vaultArguments({
        op: "setcookies",
        cookies: [{}],
        cdp_url: endpoint,
      })
      assert.equal(mapped.ok, false, String(endpoint))
    }
  })

  it("does not forward an endpoint to a vault-backed op", () => {
    // Only the cookie pair is exempt from the own-worker rule, so only the
    // cookie pair carries an endpoint. Widening this is a separate decision:
    // what it would buy, an admin pointing save_state at a named browser, is
    // not asked for by anything today.
    const mapped = vaultArguments({
      op: "save_state",
      service: "github",
      profile: "me",
      cdp_url: "wss://chrome.example.net",
    })
    assert.equal(mapped.ok, true)
    assert.equal(mapped.ok ? mapped.args["cdp_url"] : undefined, undefined)
  })

  it("accepts a cookie jar inline and echoes the op", () => {
    const jar = [{name: "sid", value: "x", domain: "example.com"}]
    const mapped = vaultArguments({op: "setcookies", cookies: jar})
    assert.equal(mapped.ok, true)
    assert.equal(mapped.ok ? mapped.echo : undefined, "setcookies")
    assert.deepEqual(mapped.ok ? mapped.args["cookies"] : [], jar)
  })

  it("refuses a setcookies that would set nothing", () => {
    assert.equal(vaultArguments({op: "setcookies"}).ok, false)
    assert.equal(vaultArguments({op: "setcookies", cookies: []}).ok, false)
    // A malformed entry is dropped, and dropping the only one is empty too.
    assert.equal(
      vaultArguments({op: "setcookies", cookies: ["junk"]}).ok,
      false
    )
  })

  it("sends no port to either cookie op", () => {
    const mapped = vaultArguments({
      op: "setcookies",
      cookies: [{n: "a"}],
      port: 9222,
    })
    assert.equal(mapped.ok, true)
    assert.equal(mapped.ok ? "port" in mapped.args : true, false)
  })

  it("refuses a name that would climb out of the profile dir", () => {
    // `service` and `profile` become path segments on the worker
    // (`profiles_dir()/<service>/<profile>`), so the guard has to be stricter
    // than "non-empty": `..` and an embedded separator are refused here rather
    // than forwarded into a filesystem join.
    for (const service of ["..", "a/b", "../etc", ".", "", "a\\b"]) {
      const mapped = vaultArguments({
        op: "save_state",
        service,
        profile: "me",
      })
      assert.equal(mapped.ok, false, service)
    }

    const badProfile = vaultArguments({
      op: "login",
      service: "github",
      profile: "../etc",
      url: "https://example.com/login",
    })
    assert.equal(badProfile.ok, false)
  })
})
