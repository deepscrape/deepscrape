/* eslint-disable max-len */
/**
 * The usage page reports what each capability cost, and that number has to agree with the
 * total on the same card. Two ways it silently would not: a row outside the range leaking
 * into a bucket, and a row with no `reason` being dropped instead of landing in `unknown`.
 * Both look fine on a dashboard with one capability and wrong on a real account.
 *
 * The ledger stores `consume` rows with a NEGATIVE delta (credits spent), so the report must
 * take the magnitude — returning the raw delta would make every meter negative.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {summarizeMeteredConsumes, type MeteredConsumeRow} from "./stripe"

const at = (ms: number) => ({toMillis: () => ms})
const window = {startMs: 1_000, endMs: 2_000}

/**
 * The breakdown's key/credits/events, without `machines`.
 *
 * Deliberately field-selective: `machines` is an attribution detail that only the
 * session meter populates, and every one of these cases is about grouping. Comparing
 * whole objects here would have made adding one column a seven-assertion edit, and
 * would then keep breaking on the next column for the same non-reason.
 * @param {*} rows Consume rows to summarise.
 * @param {*} within Inclusive window, defaulting to the shared one.
 * @return {*} The breakdown as key/credits/events only.
 */
const totals = (rows: MeteredConsumeRow[], within = window) =>
  summarizeMeteredConsumes(rows, within).metered.map(({key, credits, events}) => ({key, credits, events}))

/**
 * per-capability metered totals
 */
describe("summarizeMeteredConsumes", () => {
  it("counts a consume row by its magnitude, since the ledger stores it negative", () => {
    const result = summarizeMeteredConsumes(
      [{delta: -3, reason: "crawl.execute", createdAt: at(1_500)}],
      window,
    )

    assert.equal(result.creditsUsed, 3)
    assert.deepEqual(totals([{delta: -3, reason: "crawl.execute", createdAt: at(1_500)}]), [{key: "crawl.execute", credits: 3, events: 1}])
  })

  it("takes the window as inclusive at both ends", () => {
    const rows: MeteredConsumeRow[] = [
      {delta: -1, reason: "a", createdAt: at(1_000)},
      {delta: -1, reason: "a", createdAt: at(2_000)},
    ]

    assert.equal(summarizeMeteredConsumes(rows, window).creditsUsed, 2)
  })

  it("leaves out rows outside the window entirely", () => {
    const rows: MeteredConsumeRow[] = [
      {delta: -5, reason: "crawl.execute", createdAt: at(999)},
      {delta: -7, reason: "crawl.execute", createdAt: at(2_001)},
      {delta: -2, reason: "crawl.execute", createdAt: at(1_500)},
    ]

    const result = summarizeMeteredConsumes(rows, window)

    assert.equal(result.creditsUsed, 2)
    assert.deepEqual(totals(rows), [{key: "crawl.execute", credits: 2, events: 1}])
  })

  it("ignores ledger rows that are not consumes", () => {
    // The read is bounded by `createdAt` alone (a second filtered field would
    // need a composite index), so a period's grants and reservations arrive next
    // to its consumes. A grant's POSITIVE delta counted as spend is the failure
    // this pins: 120 granted credits would have shown up as 120 spent.
    const rows: MeteredConsumeRow[] = [
      {operation: "grant", delta: 120, reason: "grant", createdAt: at(1_100)},
      {operation: "reserve", delta: 0, reason: "meter:block", createdAt: at(1_200)},
      {operation: "consume", delta: -3, reason: "crawl.execute", createdAt: at(1_300)},
    ]

    const result = summarizeMeteredConsumes(rows, window)

    assert.equal(result.creditsUsed, 3)
    assert.deepEqual(totals(rows), [{key: "crawl.execute", credits: 3, events: 1}])
  })

  it("groups by reason and counts the events behind each total", () => {
    const rows: MeteredConsumeRow[] = [
      {delta: -3, reason: "crawl.execute", createdAt: at(1_100)},
      {delta: -3, reason: "crawl.execute", createdAt: at(1_200)},
      {delta: -1, reason: "webrain.navigate", createdAt: at(1_300)},
    ]

    const result = summarizeMeteredConsumes(rows, window)

    assert.equal(result.creditsUsed, 7)
    assert.deepEqual(totals(rows), [
      {key: "crawl.execute", credits: 6, events: 2},
      {key: "webrain.navigate", credits: 1, events: 1},
    ])
  })

  it("falls back to source when a row predates the reason field", () => {
    const rows: MeteredConsumeRow[] = [{delta: -2, source: "browser_block", createdAt: at(1_500)}]

    assert.deepEqual(totals(rows), [{key: "browser_block", credits: 2, events: 1}])
  })

  it("buckets a row with neither field rather than dropping it", () => {
    // The breakdown must still sum to the total, or the page shows a card that contradicts
    // itself. An unnamed bucket is the lesser evil.
    const rows: MeteredConsumeRow[] = [{delta: -4, createdAt: at(1_500)}]
    const result = summarizeMeteredConsumes(rows, window)

    assert.equal(result.creditsUsed, 4)
    assert.deepEqual(totals(rows), [{key: "unknown", credits: 4, events: 1}])
  })

  it("sorts by credits descending, so the largest cost leads", () => {
    const rows: MeteredConsumeRow[] = [
      {delta: -1, reason: "small", createdAt: at(1_100)},
      {delta: -9, reason: "large", createdAt: at(1_200)},
      {delta: -4, reason: "middle", createdAt: at(1_300)},
    ]

    assert.deepEqual(
      summarizeMeteredConsumes(rows, window).metered.map((entry) => entry.key),
      ["large", "middle", "small"],
    )
  })

  it("returns zero and an empty breakdown for an empty ledger", () => {
    assert.deepEqual(summarizeMeteredConsumes([], window), {creditsUsed: 0, metered: []})
  })

  it("counts DISTINCT machines behind a session meter, not one per block", () => {
    // Every block of every session carries the same reason, so a plain row count
    // says 4 while the honest answer is "two machines". This is the join the usage
    // page was missing.
    const rows: MeteredConsumeRow[] = [
      {delta: -1, reason: "meter:block", machineId: "m-1", createdAt: at(1_100)},
      {delta: -1, reason: "meter:block", machineId: "m-1", createdAt: at(1_200)},
      {delta: -1, reason: "meter:block", machineId: "m-2", createdAt: at(1_300)},
      {delta: -1, reason: "meter:block", machineId: "m-1", createdAt: at(1_400)},
    ]

    const [meter] = summarizeMeteredConsumes(rows, window).metered

    assert.equal(meter.key, "meter:block")
    assert.equal(meter.events, 4)
    assert.equal(meter.machines, 2)
  })

  it("reports 0 machines for a capability that carries no machine id", () => {
    // A request-priced capability is not "one machine" -- reporting 1 would be a
    // number the ledger never asserted.
    const [row] = summarizeMeteredConsumes(
      [{delta: -3, reason: "crawl.execute", createdAt: at(1_500)}],
      window,
    ).metered

    assert.equal(row.machines, 0)
  })

  it("ignores blank machine ids rather than counting them as a machine", () => {
    const [row] = summarizeMeteredConsumes(
      [
        {delta: -1, reason: "meter:block", machineId: "  ", createdAt: at(1_100)},
        {delta: -1, reason: "meter:block", machineId: null, createdAt: at(1_200)},
      ],
      window,
    ).metered

    assert.equal(row.machines, 0)
  })
})
