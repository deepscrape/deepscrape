/* eslint-disable object-curly-spacing */
/**
 * The monitor model's rules.
 *
 * Every assertion here is about a decision that is invisible through a live
 * check: that a 304 is terminal and bodyless, that a first check is a baseline
 * rather than a change, that a foreign uid is not an owner, and that an
 * unusable name is refused rather than quietly replaced. None of that is
 * observable from a test that needs Firestore or a worker.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  MONITOR_CHECK_RETENTION,
  MONITOR_CHECKS_LIMIT_DEFAULT,
  MONITOR_CHECKS_LIMIT_MAX,
  MONITOR_DEFAULT_INTERVAL_MINUTES,
  MONITOR_DISABLED_NEXT_CHECK,
  MONITOR_MAX_INTERVAL_MINUTES,
  MONITOR_MIN_INTERVAL_MINUTES,
  buildMonitorFields,
  buildMonitorPatch,
  clampIntervalMinutes,
  isOwnedBy,
  monitorCheckFromScrape,
  nextCheckAtFor,
  nextConsecutiveErrors,
  parseChecksRequest,
  sha256Hex,
  type MonitorFields,
} from "./monitors.domain"

/** The stored shape of one monitor, with fields under test overridden.
 * @param {Partial<MonitorFields>} overrides The fields to override.
 * @return {MonitorFields} A complete stored monitor.
 */
const monitor = (
  overrides: Partial<MonitorFields> = {}
): MonitorFields => ({
  uid: "user-1",
  url: "https://example.test/page",
  name: "page",
  intervalMinutes: 60,
  enabled: true,
  consecutiveErrors: 0,
  createdAt: 1_000,
  updatedAt: 1_000,
  nextCheckAt: 1_000,
  ...overrides,
})

/**
 * A `webrain_scrape` payload: the worker answers
 * `{"status":"ok","result":{url,status,content_type,text,bytes}}`.
 * @param {number} status The HTTP status the worker saw.
 * @param {string} text The body it returned.
 * @return {*} The parsed payload.
 */
const scrapePayload = (status: number, text: string) => ({
  status: "ok",
  result: {
    url: "https://example.test/page",
    status,
    content_type: "text/html",
    text,
    bytes: text.length,
  },
})

describe("interval bounds", () => {
  it("floors a request below the minimum and defaults junk", () => {
    assert.equal(clampIntervalMinutes(1), MONITOR_MIN_INTERVAL_MINUTES)
    assert.equal(clampIntervalMinutes(0), MONITOR_MIN_INTERVAL_MINUTES)
    assert.equal(clampIntervalMinutes(5), MONITOR_MIN_INTERVAL_MINUTES)
    assert.equal(
      clampIntervalMinutes("60"),
      MONITOR_DEFAULT_INTERVAL_MINUTES
    )
    assert.equal(
      clampIntervalMinutes(undefined),
      MONITOR_DEFAULT_INTERVAL_MINUTES
    )
  })

  it("ceils a request above the maximum", () => {
    assert.equal(
      clampIntervalMinutes(999_999),
      MONITOR_MAX_INTERVAL_MINUTES
    )
  })

  it("keeps a value that is already legal", () => {
    assert.equal(clampIntervalMinutes(1440), 1440)
  })
})

describe("nextCheckAtFor", () => {
  it("adds the interval when the monitor is on", () => {
    assert.equal(nextCheckAtFor(true, 5, 1_000), 1_000 + 5 * 60_000)
  })

  it("parks a disabled monitor beyond any wall clock", () => {
    // This is the entire mechanism by which `enabled: false` leaves the drain's
    // range query; a plain null would still be matched by `<= now`.
    assert.equal(nextCheckAtFor(false, 5, 1_000), MONITOR_DISABLED_NEXT_CHECK)
  })
})

describe("buildMonitorFields", () => {
  it("needs a url, and refuses private space", () => {
    for (const body of [undefined, {}, { url: "" }, { url: "not a url" }]) {
      assert.equal(buildMonitorFields("u", body ?? {}, 1).ok, false)
    }

    // The same guard a crawl uses: cloud metadata lives at 169.254.169.254.
    const blocked = buildMonitorFields(
      "u",
      { url: "http://169.254.169.254/latest/meta-data" },
      1
    )
    assert.equal(blocked.ok, false)
    const loopback = buildMonitorFields(
      "u",
      { url: "http://127.0.0.1:8080/x" },
      1
    )
    assert.equal(loopback.ok, false)
  })

  it("defaults the name to the url, and starts enabled", () => {
    const built = buildMonitorFields(
      "user-1",
      { url: "  https://example.test/a  " },
      1_000
    )
    assert.equal(built.ok, true)
    assert.equal(built.ok ? built.monitor.name : "", "https://example.test/a")
    assert.equal(built.ok ? built.monitor.url : "", "https://example.test/a")
    assert.equal(built.ok ? built.monitor.enabled : false, true)
    assert.equal(built.ok ? built.monitor.consecutiveErrors : -1, 0)
  })

  it("refuses a name that was sent but is unusable", () => {
    const built = buildMonitorFields(
      "u",
      { url: "https://example.test/a", name: "   " },
      1
    )
    assert.equal(built.ok, false)

    const long = buildMonitorFields(
      "u",
      { url: "https://example.test/a", name: "x".repeat(200) },
      1
    )
    assert.equal(long.ok, false)
  })

  it("clamps the interval and carries the optional refinements", () => {
    const built = buildMonitorFields(
      "u",
      {
        url: "https://example.test/a",
        intervalMinutes: 1,
        selector: " #price ",
        extractMode: "text",
      },
      1_000
    )
    assert.equal(built.ok ? built.monitor.intervalMinutes : 0, 5)
    assert.equal(built.ok ? built.monitor.selector : "", "#price")
    assert.equal(built.ok ? built.monitor.extractMode : "", "text")
  })
})

describe("buildMonitorPatch", () => {
  it("refuses a patch that changes nothing it understands", () => {
    const patched = buildMonitorPatch(monitor(), { id: "m1" }, 2_000)
    assert.equal(patched.ok, false)
  })

  it("re-derives the due-time when the interval changes", () => {
    const patched = buildMonitorPatch(
      monitor({ intervalMinutes: 60 }),
      { intervalMinutes: 15 },
      2_000
    )
    assert.equal(patched.ok, true)
    assert.equal(
      patched.ok ? patched.patch["nextCheckAt"] : 0,
      2_000 + 15 * 60_000
    )
  })

  it("parks the due-time when the monitor is switched off", () => {
    const patched = buildMonitorPatch(monitor(), { enabled: false }, 2_000)
    assert.equal(patched.ok, true)
    assert.equal(
      patched.ok ? patched.patch["nextCheckAt"] : 0,
      MONITOR_DISABLED_NEXT_CHECK
    )
  })

  it("clears an optional field with null rather than undefined", () => {
    // Firestore rejects an undefined field value for the whole write, so
    // "cleared" has to be spelled as null.
    const patched = buildMonitorPatch(
      monitor({ selector: "#x" }),
      { selector: "  " },
      2_000
    )
    assert.equal(patched.ok, true)
    assert.equal(patched.ok ? patched.patch["selector"] : "unset", null)
  })

  it("refuses a url that the guard would refuse", () => {
    const patched = buildMonitorPatch(
      monitor(),
      { url: "http://localhost/admin" },
      2_000
    )
    assert.equal(patched.ok, false)
  })
})

describe("isOwnedBy", () => {
  it("is false for a missing monitor and for another account", () => {
    assert.equal(isOwnedBy(undefined, "user-1"), false)
    assert.equal(isOwnedBy(monitor({ uid: "user-2" }), "user-1"), false)
  })

  it("is true only for the owner", () => {
    assert.equal(isOwnedBy(monitor({ uid: "user-1" }), "user-1"), true)
  })
})

describe("monitorCheckFromScrape", () => {
  it("treats a 304 as a terminal, bodyless 'unchanged'", () => {
    // The whole point: no body is required to conclude this, and the stored
    // hash is NOT replaced.
    const outcome = monitorCheckFromScrape(
      scrapePayload(304, ""),
      "previous-hash"
    )
    assert.equal(outcome.status, "unchanged")
    assert.equal(outcome.httpStatus, 304)
    assert.equal(outcome.changed, false)
    assert.equal(outcome.hash, undefined)
    assert.equal(outcome.error, undefined)
  })

  it("is unchanged for the same body and changed for a new one", () => {
    const body = "<html>price 10</html>"
    const hash = sha256Hex(body)

    const same = monitorCheckFromScrape(scrapePayload(200, body), hash)
    assert.equal(same.status, "unchanged")
    assert.equal(same.changed, false)
    assert.equal(same.hash, hash)

    const changed = monitorCheckFromScrape(
      scrapePayload(200, "<html>price 11</html>"),
      hash
    )
    assert.equal(changed.status, "changed")
    assert.equal(changed.changed, true)
    assert.equal(changed.hash, sha256Hex("<html>price 11</html>"))
  })

  it("establishes a baseline on the first check, not a change", () => {
    const first = monitorCheckFromScrape(
      scrapePayload(200, "<html>a</html>"),
      undefined
    )
    assert.equal(first.status, "unchanged")
    assert.equal(first.changed, false)
    assert.equal(first.hash, sha256Hex("<html>a</html>"))
  })

  it("reports a non-2xx page as an error carrying the status", () => {
    const outcome = monitorCheckFromScrape(scrapePayload(500, ""), undefined)
    assert.equal(outcome.status, "error")
    assert.equal(outcome.httpStatus, 500)
    assert.match(outcome.error ?? "", /500/)
  })

  it("reads the provider's own error envelope", () => {
    const outcome = monitorCheckFromScrape(
      { status: "error", message: "url required" },
      undefined
    )
    assert.equal(outcome.status, "error")
    assert.equal(outcome.error, "url required")
  })

  it("reports a payload with no result as an error", () => {
    const outcome = monitorCheckFromScrape({ status: "ok" }, undefined)
    assert.equal(outcome.status, "error")
    assert.match(outcome.error ?? "", /no page/)
  })
})

describe("nextConsecutiveErrors", () => {
  it("increments on error and resets on anything else", () => {
    assert.equal(nextConsecutiveErrors(0, "error"), 1)
    assert.equal(nextConsecutiveErrors(4, "error"), 5)
    assert.equal(nextConsecutiveErrors(4, "unchanged"), 0)
    assert.equal(nextConsecutiveErrors(4, "changed"), 0)
  })
})

describe("parseChecksRequest", () => {
  it("requires an id", () => {
    assert.equal(parseChecksRequest({}, {}).ok, false)
    assert.equal(parseChecksRequest(undefined, undefined).ok, false)
  })

  it("defaults and clamps the limit, and accepts it as a string", () => {
    const dflt = parseChecksRequest({ id: "m1" }, {})
    assert.equal(dflt.ok ? dflt.limit : 0, MONITOR_CHECKS_LIMIT_DEFAULT)

    const high = parseChecksRequest({ id: "m1", limit: "1000" }, {})
    assert.equal(high.ok ? high.limit : 0, MONITOR_CHECKS_LIMIT_MAX)

    const low = parseChecksRequest({ id: "m1", limit: 0 }, {})
    assert.equal(low.ok ? low.limit : 0, 1)
  })

  it("refuses a limit that is not a whole number", () => {
    assert.equal(parseChecksRequest({ id: "m1", limit: "x" }, {}).ok, false)
    assert.equal(parseChecksRequest({ id: "m1", limit: 1.5 }, {}).ok, false)
  })

  it("falls back to the body, which the route also accepts", () => {
    const parsed = parseChecksRequest({}, { id: "m1", limit: 5 })
    assert.equal(parsed.ok, true)
    assert.equal(parsed.ok ? parsed.id : "", "m1")
    assert.equal(parsed.ok ? parsed.limit : 0, 5)
  })
})

describe("retention bound", () => {
  it("is a positive bound that a prune can act on", () => {
    assert.ok(MONITOR_CHECK_RETENTION > 0)
    assert.ok(Number.isInteger(MONITOR_CHECK_RETENTION))
  })
})
