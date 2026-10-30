import { CrawlOperationStatus } from '../enum'

/**
 * The three visual pieces a status badge needs.
 *
 * Returned as separate classes rather than one string so a caller can show a
 * dot without a background, or a background without a dot, without inventing a
 * second map. Every value is a complete, literal Tailwind class: nothing here
 * is interpolated, because a class built at runtime (`bg-${colour}-100`) never
 * appears in the source Tailwind scans and is therefore never emitted.
 */
export interface StatusTone {
  /** The badge's background, with a dark-mode variant. */
  bg: string
  /** The badge's text colour, with a dark-mode variant. */
  text: string
  /** The small dot used where a full badge would be too heavy. */
  dot: string
}

/**
 * One entry per status, so a status added to the enum is a compile error here
 * rather than a badge that silently renders as "neutral".
 *
 * Hues follow the repository theme: cyan is the live accent, rose is the
 * warning/failure accent, and muted grey is "nothing is happening". Emerald is
 * used only for a finished success because the theme map asks new UI to prefer
 * rose elsewhere.
 */
const TONE: Record<CrawlOperationStatus, StatusTone> = {
  [CrawlOperationStatus.READY]: {
    bg: 'bg-gray-100 dark:bg-gray5/50',
    text: 'text-gray-700 dark:text-gray-200',
    dot: 'bg-gray-400 dark:bg-gray-300',
  },
  [CrawlOperationStatus.STARTED]: {
    bg: 'bg-cyan-50 dark:bg-cyan-950/40',
    text: 'text-cyan-800 dark:text-cyan-200',
    dot: 'bg-cyan-500 dark:bg-cyan-400',
  },
  [CrawlOperationStatus.SCHEDULED]: {
    bg: 'bg-indigo-50 dark:bg-indigo-950/40',
    text: 'text-indigo-800 dark:text-indigo-200',
    dot: 'bg-indigo-500 dark:bg-indigo-400',
  },
  [CrawlOperationStatus.IN_PROGRESS]: {
    bg: 'bg-cyan-50 dark:bg-cyan-950/40',
    text: 'text-cyan-800 dark:text-cyan-200',
    dot: 'bg-cyan-500 dark:bg-cyan-400',
  },
  [CrawlOperationStatus.PENDING]: {
    bg: 'bg-amber-50 dark:bg-amber-950/40',
    text: 'text-amber-800 dark:text-amber-200',
    dot: 'bg-amber-500 dark:bg-amber-400',
  },
  [CrawlOperationStatus.PAUSED]: {
    bg: 'bg-amber-50 dark:bg-amber-950/40',
    text: 'text-amber-800 dark:text-amber-200',
    dot: 'bg-amber-500 dark:bg-amber-400',
  },
  [CrawlOperationStatus.COMPLETED]: {
    bg: 'bg-emerald-50 dark:bg-emerald-950/40',
    text: 'text-emerald-800 dark:text-emerald-200',
    dot: 'bg-emerald-500 dark:bg-emerald-400',
  },
  [CrawlOperationStatus.FAILED]: {
    bg: 'bg-rose-50 dark:bg-rose-950/40',
    text: 'text-rose-800 dark:text-rose-200',
    dot: 'bg-rose-500 dark:bg-rose-400',
  },
  [CrawlOperationStatus.CANCELED]: {
    bg: 'bg-gray-100 dark:bg-gray5/50',
    text: 'text-gray-600 dark:text-gray-300',
    dot: 'bg-gray-400 dark:bg-gray-300',
  },
}

/** The tone used for a status this build does not recognise. */
const NEUTRAL: StatusTone = TONE[CrawlOperationStatus.READY]

/**
 * The tone for one status.
 *
 * Unknown values get the neutral tone instead of throwing: the status comes from
 * a document written by another service, and a badge is not worth a broken list.
 * @param {string} status The status, as stored or as received from the job.
 * @return {StatusTone} The background, text and dot classes.
 */
export function statusTone(status: string | null | undefined): StatusTone {
  if (!status) return NEUTRAL
  return TONE[status as CrawlOperationStatus] ?? NEUTRAL
}

/**
 * The full class list for a status badge, including its base geometry.
 * @param {string} status The status.
 * @return {string} Classes for a rounded pill.
 */
export function statusBadgeClass(status: string | null | undefined): string {
  const tone = statusTone(status)
  return (
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 ' +
    'text-xs font-medium ' +
    tone.bg +
    ' ' +
    tone.text
  )
}
