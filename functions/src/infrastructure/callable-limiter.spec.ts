/* eslint-disable max-len */
import assert from "node:assert/strict"
import test from "node:test"
import {redis} from "../app/cacheConfig"
import {APP_CHECK_ENFORCED, applyAppCheckPolicy, enforceCallableRateLimit, guardedOnCall, resolveCallableLimitKey} from "./callable-limiter"

// Covers the branches reachable without mocking Redis. The counter itself is the same
// atomic FIXED_WINDOW_INCREMENT Lua script already exercised by
// sendDeviceVerificationCode; what is new and worth pinning here is the wiring — the
// key derivation, the overload dispatch inside the cast, and that the request still
// reaches the handler.

test("resolveCallableLimitKey keys by uid when there is one, by IP otherwise", () => {
  // The verified uid is the better bucket and must win even when an IP is present.
  assert.equal(
    resolveCallableLimitKey({auth: {uid: "u1"}, rawRequest: {ip: "203.0.113.7"}}),
    "callableRateLimit:u1",
  )

  // The LAST entry. A trusted proxy APPENDS the address it saw, so everything to
  // its left came from the caller -- a leading loopback here is a spoof attempt
  // and must not win. Keying on index 0 was how a rotating header minted a fresh
  // bucket per request, i.e. no limiter at all.
  assert.equal(
    resolveCallableLimitKey({auth: null, rawRequest: {headers: {"x-forwarded-for": "127.0.0.1, 203.0.113.7"}}}),
    "callableRateLimit:ip:203.0.113.7",
  )

  // No loopback exemption any more: claiming loopback used to mean "skip
  // metering", which is exactly what an anonymous caller would send.
  assert.equal(
    resolveCallableLimitKey({auth: null, rawRequest: {ip: "127.0.0.1"}}),
    "callableRateLimit:ip:127.0.0.1",
  )
  assert.equal(
    resolveCallableLimitKey({auth: null, rawRequest: {ip: "::1"}}),
    "callableRateLimit:ip:::1",
  )
  // An address the platform cannot derive collapses to one shared bucket rather
  // than to nothing. `null` is never returned for an anonymous caller now.
  assert.equal(resolveCallableLimitKey({}), "callableRateLimit:ip:unknown")
})

test("enforceCallableRateLimit resolves even with no identifiable caller", async () => {
  // Must resolve, not throw: a callable that cannot be invoked at all is worse than
  // one that is unmetered -- this limiter fails OPEN by design. Note the caller is
  // still METERED: an anonymous caller with no derivable address shares the single
  // `unknown` bucket, because a callable never rejecting an anonymous caller (the
  // guest heartbeat) is what made "no uid => nothing to meter" unbounded.
  await enforceCallableRateLimit({})
  await enforceCallableRateLimit({auth: null})
})

test("guardedOnCall returns a callable for both overload shapes", () => {
  // Both forms are used in this repo: onCall(handler) and onCall(opts, handler).
  assert.ok(guardedOnCall(async () => "ok"), "handler-only overload returned nothing")
  assert.ok(guardedOnCall({region: "us-central1"}, async () => "ok"), "options overload returned nothing")
})

test("guardedOnCall still passes the request through to the handler", async () => {
  let seen: unknown = null
  const wrapped = guardedOnCall(async (request: unknown) => {
    seen = request
    return "ok"
  }) as unknown as {run: (r: unknown) => Promise<unknown>}

  const request = {auth: null, data: {hello: "world"}}
  const result = await wrapped.run(request)

  // If the wrapper ever swallows the handler call, this fails.
  assert.equal(result, "ok")
  assert.equal(seen, request)
})

test("guardedOnCall rejects a closed account before the handler runs", async () => {
  // The tombstone lookup fails OPEN on a Redis error and this environment has no Redis,
  // so stub the shared client for the duration. Patching the object the module already
  // closed over exercises the real code path instead of inventing a test-only seam.
  const client = redis as unknown as {get: (key: string) => Promise<unknown>}
  const originalGet = client.get

  let handlerRan = false
  const wrapped = guardedOnCall(async () => {
    handlerRan = true
    return "ok"
  }) as unknown as {run: (r: unknown) => Promise<unknown>}

  try {
    client.get = async () => "1"

    await assert.rejects(
      wrapped.run({auth: {uid: "closed_account"}}),
      (error: {code?: string}) => error.code === "permission-denied",
    )

    // The point of the gate: the handler must never see the request. Disabling the Auth
    // record only stops the NEXT token, so without this a token minted a minute earlier
    // keeps full access to every callable — including billing and account administration
    // — for up to an hour. Before this guard, only the Express routes were covered.
    assert.equal(handlerRan, false, "handler ran for a closed account")

    // A live account is unaffected.
    client.get = async () => null
    handlerRan = false
    assert.equal(await wrapped.run({auth: {uid: "live_account"}}), "ok")
    assert.equal(handlerRan, true)

    // An anonymous invocation has no uid to look up: it must not be rejected by a lookup
    // keyed on nothing. Guest callers (the heartbeat) rely on this.
    client.get = async () => "1"
    assert.equal(await wrapped.run({auth: null}), "ok")
  } finally {
    client.get = originalGet
  }
})

test("applyAppCheckPolicy keeps the server in lockstep with a client that sends no token", () => {
  // app.config.ts no longer calls provideAppCheck(), so the browser sends no App Check
  // token, and firebase-functions rejects a MISSING app token with a bare
  // HttpsError("unauthenticated", "Unauthenticated") whenever enforceAppCheck is true.
  // Nine callables in gfunctions/sessions.ts declared `true` and were therefore dead for
  // every real user — session revoke, sign-out, device removal, MFA preferences and both
  // halves of device verification. 156 tests passed with all of that broken, so pin it.
  assert.equal(APP_CHECK_ENFORCED, false, "flip this only after provideAppCheck() is restored")

  // A declared `true` must not survive while the client cannot produce a token: that is
  // precisely the combination that turns a hardening flag into an outage.
  const declaredTrue = applyAppCheckPolicy({region: "us-central1", enforceAppCheck: true})
  assert.equal(
    declaredTrue["enforceAppCheck"],
    false,
    "enforceAppCheck: true with a tokenless client makes the callable unreachable",
  )

  // Every other option is load-bearing for deployment (secrets, region, memory, cors)
  // and must pass through untouched.
  assert.equal(declaredTrue["region"], "us-central1")
  const declaredFalse = applyAppCheckPolicy({secrets: ["a"], memory: "256MiB", enforceAppCheck: false})
  assert.deepEqual(declaredFalse["secrets"], ["a"])
  assert.equal(declaredFalse["memory"], "256MiB")
  assert.equal(declaredFalse["enforceAppCheck"], false)

  // The effective value is always the call site's intent AND the global switch, so the
  // two halves can only be enabled together.
  assert.equal(
    applyAppCheckPolicy({enforceAppCheck: true})["enforceAppCheck"],
    APP_CHECK_ENFORCED,
  )
})
