/* eslint-disable max-len */
/**
 * `analytics_events` — append-only fact table.
 *
 * Written by the existing realtime triggers (guests / users / login_metrics)
 * inside the same batch as the `metrics_*` rollups, so the pipeline keeps a
 * single writer.
 *
 * Why facts on top of the rollups: `metrics_daily` can only answer questions
 * the trigger knew to increment. Per-user sequences (funnels, retention
 * cohorts, bot-free conversion) need the raw events.
 *
 * ponytail: one flat collection instead of one per event type — a funnel or
 * cohort query stays a single `where date >= x` read.
 */

export const ANALYTICS_EVENTS = "analytics_events"

/** Raw events are pruned by `cleanupOldAnalytics`; rollups keep 365 days. */
export const ANALYTICS_EVENTS_RETENTION_DAYS = 180

export type AnalyticsEventProps = Record<string, string | number | boolean | null>

export type AnalyticsEvent = {
  /** Server facts use `guest_created` / `user_registered` / `login_succeeded`;
   *  drained client events use the client's `eventType`. */
  name: string
  /** UTC day key (YYYY-MM-DD) — matches `metrics_daily/{date}`. */
  date: string
  ts: Date
  uid: string
  guestId: string | null
  isBot: boolean
  botKind: string | null
  /** Event links a guest to a user account (guest → signup). */
  isConversion: boolean
  props: AnalyticsEventProps
}

export type AnalyticsEventInput = {
  name: string
  ts?: Date
  uid?: string | null
  guestId?: string | null
  isBot?: boolean | null
  botKind?: string | null
  isConversion?: boolean
  props?: AnalyticsEventProps
}

/** UTC day key used for both `metrics_daily` and `analytics_events`. */
/**
 * toEventDate
 * @param {*} ts
 * @return {*}
 */
export function toEventDate(ts: Date): string {
  return ts.toISOString().split("T")[0]
}

/** UTC hour key used for `metrics_hourly` (`YYYY-MM-DD-HH`), read by the 30m/1h/24h ranges. */
/**
 * toEventHour
 * @param {*} ts
 * @return {*}
 */
export function toEventHour(ts: Date): string {
  return `${toEventDate(ts)}-${String(ts.getUTCHours()).padStart(2, "0")}`
}

/** Normalize a trigger's context into the stored fact. */
/**
 * buildAnalyticsEvent
 * @param {*} input
 * @return {*}
 */
export function buildAnalyticsEvent(input: AnalyticsEventInput): AnalyticsEvent {
  const ts = input.ts || new Date()

  return {
    name: input.name,
    date: toEventDate(ts),
    ts,
    uid: input.uid || "",
    guestId: input.guestId || null,
    isBot: Boolean(input.isBot),
    botKind: input.botKind || null,
    isConversion: Boolean(input.isConversion),
    props: input.props || {},
  }
}

/**
 * Dotted counter keys this fact contributes to `metrics_daily`.
 * Bots are counted separately and kept out of the funnel so conversion
 * rates are not diluted by crawlers.
 */
/**
 * toFunnelCounterKeys
 * @param {*} event
 * @return {*}
 */
export function toFunnelCounterKeys(event: Pick<AnalyticsEvent, "name" | "isBot" | "botKind">): string[] {
  if (event.isBot) {
    return ["bots", `byBotKind.${event.botKind || "bot"}`]
  }
  return [`funnel.${event.name}`]
}

/**
 * Counters a paid fact contributes to `metrics_daily`, with their deltas.
 *
 * Amounts stay currency-scoped on purpose — one mixed-currency total is silently
 * wrong, and a key per currency costs nothing. Keys remain a single level deep so
 * `collectBreakdown` can merge them into `metrics_range` later.
 */
/**
 * toPaidCounterKeys
 * @param {*} props
 * @return {*}
 */
export function toPaidCounterKeys(props: AnalyticsEventProps): Array<[string, number]> {
  const currency = String(props.currency || "unknown").toUpperCase()
  const amountMinor = Math.round(Number(props.amountMinor || 0))
  // Firestore reads a dot in a dotted field path as nesting; channel values can
  // carry a referrer hostname, so they are flattened.
  const flatten = (value: unknown): string => String(value || "").replace(/[.$]/g, "_").slice(0, 60)

  const counters: Array<[string, number]> = [
    [`revenueByCurrency.${currency}`, amountMinor],
    [`paymentsByCurrency.${currency}`, 1],
  ]

  if (props.plan) counters.push([`paidByPlan.${flatten(props.plan)}`, 1])
  if (props.channel) counters.push([`paidByChannel.${flatten(props.channel)}`, 1])
  return counters
}
