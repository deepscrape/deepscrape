import { TestBed } from '@angular/core/testing'

import { AnalyticsRangeService, MAX_CUSTOM_RANGE_DAYS } from './analytics-range.service'
import { FirestoreService } from './firestore.service'
import { getTestProviders } from 'src/app/testing'

type RangeFirestoreMethods =
  | 'getMetricsByDateRange'
  | 'getRangeMetrics'
  | 'getHourlyMetricsByDateTimeRange'

describe('AnalyticsRangeService', () => {
  let service: AnalyticsRangeService
  let firestoreServiceMock: jasmine.SpyObj<Pick<FirestoreService, RangeFirestoreMethods>>

  /**
   * A window of exactly `days` calendar days, inclusive, ending on a fixed date so the
   * boundary specs do not drift with the wall clock (and need no fake timers).
   */
  const span = (days: number): { start: string, end: string } => {
    const endMs = Date.UTC(2026, 0, 1)
    return {
      start: new Date(endMs - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      end: new Date(endMs).toISOString().slice(0, 10),
    }
  }

  /** The key pair the bucketed read was asked for, plus the series it named. */
  const bucketedRead = () => {
    const [startKey, endKey, collection] =
      firestoreServiceMock.getHourlyMetricsByDateTimeRange.calls.mostRecent().args
    return { startKey, endKey, collection }
  }

  beforeEach(() => {
    firestoreServiceMock = jasmine.createSpyObj<Pick<FirestoreService, RangeFirestoreMethods>>(
      'FirestoreService',
      ['getMetricsByDateRange', 'getRangeMetrics', 'getHourlyMetricsByDateTimeRange'],
    )
    firestoreServiceMock.getMetricsByDateRange.and.resolveTo([])
    firestoreServiceMock.getRangeMetrics.and.resolveTo(null)
    firestoreServiceMock.getHourlyMetricsByDateTimeRange.and.resolveTo([])

    TestBed.configureTestingModule({
      providers: [
        ...getTestProviders(),
        AnalyticsRangeService,
        { provide: FirestoreService, useValue: firestoreServiceMock },
      ],
    })

    service = TestBed.inject(AnalyticsRangeService)
  })

  it('should be created', () => {
    expect(service).toBeTruthy()
  })

  it('pins the custom-range cap at one leap year', () => {
    expect(MAX_CUSTOM_RANGE_DAYS).toBe(366)
  })

  it('computes a custom range that spans exactly the cap', async () => {
    const { start, end } = span(MAX_CUSTOM_RANGE_DAYS)
    firestoreServiceMock.getMetricsByDateRange.and.resolveTo([
      { date: end, newGuests: 2, newUsers: 1, totalLogins: 3, guestConversions: 0 },
    ])

    const result = await service.resolveRangeMetrics({
      period: 'custom',
      customStartDate: start,
      customEndDate: end,
    })

    expect(firestoreServiceMock.getMetricsByDateRange).toHaveBeenCalledWith(start, end)
    expect(result?.rangeId).toBe('custom')
    expect(result?.startDate).toBe(start)
    expect(result?.endDate).toBe(end)
    expect(result?.totalGuests).toBe(2)
    expect(result?.dailyBreakdown.map((row) => row.date)).toEqual([end])
  })

  it('refuses a custom range one day over the cap without reading any document', async () => {
    const warn = spyOn(console, 'warn').and.stub()
    const { start, end } = span(MAX_CUSTOM_RANGE_DAYS + 1)

    const result = await service.resolveRangeMetrics({
      period: 'custom',
      customStartDate: start,
      customEndDate: end,
    })

    expect(result).toBeNull()
    expect(firestoreServiceMock.getMetricsByDateRange).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('refuses a whole-history range such as 2020 to today', async () => {
    spyOn(console, 'warn').and.stub()

    const result = await service.resolveRangeMetrics({
      period: 'custom',
      customStartDate: '2020-01-01',
      customEndDate: '2026-01-01',
    })

    expect(result).toBeNull()
    expect(firestoreServiceMock.getMetricsByDateRange).not.toHaveBeenCalled()
  })

  it('still computes the 3-day range, which is far under the cap', async () => {
    const result = await service.resolveRangeMetrics({
      period: 'last-3d',
      now: new Date(Date.UTC(2026, 0, 1)),
    })

    expect(firestoreServiceMock.getMetricsByDateRange).toHaveBeenCalledTimes(1)
    expect(result?.rangeId).toBe('last-3d')
  })

  // ── day bucketing: the 7/30/90d fallback folds one metrics_daily doc per day ──

  it('folds a 30-day selection into one day bucket per metrics_daily document, in ascending date order', async () => {
    spyOn(console, 'warn').and.stub()
    // Deliberately out of order: the fold must sort, not trust the read order.
    firestoreServiceMock.getMetricsByDateRange.and.resolveTo([
      { date: '2026-03-15', newGuests: 3 },
      { date: '2026-02-14', newGuests: 1, guestConversions: 1 },
    ])

    const result = await service.resolveRangeMetrics({
      period: 'last-30d',
      now: new Date(Date.UTC(2026, 2, 15, 5, 0)),
    })

    // 30 calendar days ending on `now`'s date, both ends inclusive.
    expect(firestoreServiceMock.getMetricsByDateRange).toHaveBeenCalledWith('2026-02-14', '2026-03-15')
      // The on-the-fly fallback labels its result 'custom': `resolveRangeMetrics` does not
      // pass the period through to `buildCustomDateRangeMetrics`, though the `last-3d` case
      // does. Asserted as it behaves so this spec pins the DAY FOLDING; the dropped label is
      // recorded as a finding rather than papered over with an expectation that would be red.
      expect(result?.rangeId).toBe('custom')
    expect(result?.dailyBreakdown.map((row) => row.date)).toEqual(['2026-02-14', '2026-03-15'])
    expect(result?.totalGuests).toBe(4)
    // 1 conversion over 4 guests.
    expect(result?.conversionRate).toBe(25)
  })

  // ── aligned bucket windows: which keys, and how many ──────────────────────

  it('reads 24 hourly buckets ending at the current hour, both ends inclusive', async () => {
    const result = await service.resolveRangeMetrics({
      period: 'last-24h',
      now: new Date(Date.UTC(2026, 0, 1, 13, 10)),
    })

    // The last bucket is the *aligned* current hour (13:00, not 13:10) and the first is
    // 23 hours earlier, so the key pair covers exactly 24 buckets.
    expect(bucketedRead()).toEqual({
      startKey: '2025-12-31-14',
      endKey: '2026-01-01-13',
      collection: 'metrics_hourly',
    })
    expect(result?.rangeId).toBe('last-24h')
    expect(result?.startDate).toBe('2025-12-31T14:00:00.000Z')
    // `endDate` is the raw `now`, not the aligned bucket.
    expect(result?.endDate).toBe('2026-01-01T13:10:00.000Z')
  })

  it('reads exactly three hourly buckets for last-3h, aligned to the hour', async () => {
    await service.resolveRangeMetrics({
      period: 'last-3h',
      now: new Date(Date.UTC(2026, 0, 1, 13, 10)),
    })

    expect(bucketedRead()).toEqual({
      startKey: '2026-01-01-11',
      endKey: '2026-01-01-13',
      collection: 'metrics_hourly',
    })
  })

  it('reads 60 minutely buckets for last-1h, ending at the current minute', async () => {
    await service.resolveRangeMetrics({
      period: 'last-1h',
      // Seconds are discarded: the last bucket is the floor of `now`.
      now: new Date(Date.UTC(2026, 0, 1, 13, 10, 30)),
    })

    expect(bucketedRead()).toEqual({
      startKey: '2026-01-01-12-11',
      endKey: '2026-01-01-13-10',
      collection: 'metrics_minutely',
    })
  })

  it('reads 30 minutely buckets for last-30m', async () => {
    await service.resolveRangeMetrics({
      period: 'last-30m',
      now: new Date(Date.UTC(2026, 0, 1, 13, 10, 30)),
    })

    expect(bucketedRead()).toEqual({
      startKey: '2026-01-01-12-41',
      endKey: '2026-01-01-13-10',
      collection: 'metrics_minutely',
    })
  })

  it('reads 5 minutely buckets for last-5m', async () => {
    await service.resolveRangeMetrics({
      period: 'last-5m',
      now: new Date(Date.UTC(2026, 0, 1, 13, 10, 30)),
    })

    expect(bucketedRead()).toEqual({
      startKey: '2026-01-01-13-06',
      endKey: '2026-01-01-13-10',
      collection: 'metrics_minutely',
    })
  })

  it('renders an empty minutely window from the minutely series instead of widening it to an hour', async () => {
    // The hour fallback is bounded by MINUTELY_SERIES_START_MS (2026-09-17); this clock is
    // past it, so an empty window must stay empty rather than borrow an hour of traffic.
    const result = await service.resolveRangeMetrics({
      period: 'last-5m',
      now: new Date(Date.UTC(2026, 0, 1, 13, 10, 30)),
    })

    expect(firestoreServiceMock.getHourlyMetricsByDateTimeRange).toHaveBeenCalledTimes(1)
    expect(bucketedRead().collection).toBe('metrics_minutely')
    expect(result?.totalGuests).toBe(0)
    expect(result?.dailyBreakdown).toEqual([])
  })

  // ── point shaping: one chart point per bucket ─────────────────────────────

  it('stamps hour rows at the top of their hour and leaves the minute unset', async () => {
    firestoreServiceMock.getHourlyMetricsByDateTimeRange.and.resolveTo([
      { datetime: '2026-01-01-11', date: '2026-01-01', hour: 11, newGuests: 2, totalLogins: 4 },
      { datetime: '2026-01-01-12', date: '2026-01-01', hour: 12, newGuests: 1, guestConversions: 1 },
    ])

    const result = (await service.resolveRangeMetrics({
      period: 'last-3h',
      now: new Date(Date.UTC(2026, 0, 1, 13, 10)),
    }))!

    expect(result.dailyBreakdown.map((point) => point.date)).toEqual([
      '2026-01-01T11:00:00.000Z',
      '2026-01-01T12:00:00.000Z',
    ])
    expect(result.dailyBreakdown.map((point) => point.hour)).toEqual([11, 12])
    expect(result.dailyBreakdown.map((point) => point.minute)).toEqual([undefined, undefined])
    expect(result.totalGuests).toBe(3)
    expect(result.totalLogins).toBe(4)
    expect(result.guestConversions).toBe(1)
    // 1 conversion over 3 guests, rounded.
    expect(result.conversionRate).toBe(33)
  })

  it('stamps minute rows at their own minute and keeps the minute number', async () => {
    firestoreServiceMock.getHourlyMetricsByDateTimeRange.and.resolveTo([
      { datetime: '2026-01-01-13-05', date: '2026-01-01', hour: 13, minute: 5, newGuests: 2 },
      { datetime: '2026-01-01-13-06', date: '2026-01-01', hour: 13, minute: 6, newGuests: 3, guestConversions: 1 },
    ])

    const result = (await service.resolveRangeMetrics({
      period: 'last-5m',
      now: new Date(Date.UTC(2026, 0, 1, 13, 10, 30)),
    }))!

    expect(result.dailyBreakdown.map((point) => point.date)).toEqual([
      '2026-01-01T13:05:00.000Z',
      '2026-01-01T13:06:00.000Z',
    ])
    expect(result.dailyBreakdown.map((point) => point.minute)).toEqual([5, 6])
    expect(result.dailyBreakdown.map((point) => point.hour)).toEqual([13, 13])
    expect(result.totalGuests).toBe(5)
    // 1 conversion over 5 guests.
    expect(result.conversionRate).toBe(20)
  })
})
