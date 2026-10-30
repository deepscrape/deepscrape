import { IpNetworkIntel, IpProxyIntel, SessionDisplayInfo } from '../types'

type SessionIntelShape = Pick<SessionDisplayInfo, 'network' | 'proxy' | 'intelligenceStatus'>
type SessionRiskLevel = 'pending' | 'low' | 'medium' | 'high'

// Translator lets consumers localize the static UI copy; when absent the function
// returns the English fallback so it stays usable outside Angular/i18n.
type IntelTranslator = (key: string, params?: Record<string, unknown>) => string

const T = (t: IntelTranslator | undefined, key: string, en: string, params?: Record<string, unknown>): string =>
  t ? t(key, params) : en

const fallbackNetworkIntel: IpNetworkIntel = {
  asn: null,
  as: null,
  isp: null,
  domain: null,
  usageType: null,
}

const fallbackProxyIntel: IpProxyIntel = {
  isProxy: false,
  proxyType: null,
  threat: null,
  lastSeenDays: null,
  provider: null,
  fraudScore: null,
  confidence: 'unknown',
}

export function toNetworkIntel(raw: any): IpNetworkIntel {
  return {
    asn: cleanNullableString(raw?.network?.asn ?? raw?.asn),
    as: cleanNullableString(raw?.network?.as ?? raw?.network?.asName ?? raw?.as ?? raw?.asName),
    isp: cleanNullableString(raw?.network?.isp ?? raw?.isp),
    domain: cleanNullableString(raw?.network?.domain ?? raw?.domain),
    usageType: cleanNullableString(raw?.network?.usageType ?? raw?.usageType),
  }
}

export function toProxyIntel(raw: any): IpProxyIntel {
  const candidate = raw?.proxy || {}
  return {
    isProxy: candidate?.isProxy === true,
    proxyType: cleanNullableString(candidate?.proxyType),
    threat: cleanNullableString(candidate?.threat),
    lastSeenDays: typeof candidate?.lastSeenDays === 'number' ? candidate.lastSeenDays : null,
    provider: cleanNullableString(candidate?.provider),
    fraudScore: typeof candidate?.fraudScore === 'number' ? candidate.fraudScore : null,
    confidence: cleanNullableString(candidate?.confidence) || 'unknown',
  }
}

export function getSessionRiskLevel(session: SessionIntelShape): SessionRiskLevel {
  if (isIntelligencePending(session)) {
    return 'pending'
  }

  // A skipped lookup is not an unknown answer: the address is private or
  // reserved, `lookupGeoByIp` refused it on purpose, and there is nothing a
  // provider could have said. Scoring it as `medium` painted "Needs review" on
  // the user's own local session.
  if (isIntelligenceSkipped(session)) {
    return 'low'
  }

  const proxy = session.proxy || fallbackProxyIntel
  const threat = (proxy.threat || '').toLowerCase()
  const usageType = (session.network?.usageType || '').toLowerCase()

  if (proxy.isProxy || threat.includes('fraud') || threat.includes('spam') || threat.includes('abuse')) {
    return 'high'
  }

  if (proxy.confidence === 'unknown' || usageType.includes('data center') || usageType.includes('hosting')) {
    return 'medium'
  }

  return 'low'
}

export function getSessionRiskTone(session: SessionIntelShape): string {
  const risk = getSessionRiskLevel(session)
  if (risk === 'pending') {
    return 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300'
  }

  if (risk === 'high') {
    return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
  }

  if (risk === 'medium') {
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
  }

  return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
}

export function getSessionRiskLabel(session: SessionIntelShape, t?: IntelTranslator): string {
  const risk = getSessionRiskLevel(session)
  if (risk === 'pending') return T(t, 'INTEL.RISK_PENDING', 'Pending enrichment')
  if (risk === 'high') return T(t, 'INTEL.RISK_HIGH', 'High risk')
  if (risk === 'medium') return T(t, 'INTEL.RISK_MEDIUM', 'Needs review')
  return T(t, 'INTEL.RISK_LOW', 'Low risk')
}

export function getSessionRiskReason(session: SessionIntelShape, t?: IntelTranslator): string {
  if (isIntelligencePending(session)) {
    return T(t, 'INTEL.REASON_PENDING', 'IP intelligence enrichment is still running. This usually resolves in a few seconds.')
  }

  if (isIntelligenceSkipped(session)) {
    return T(t, 'INTEL.REASON_PRIVATE', 'Private or reserved address; no network lookup applies.')
  }

  const proxy = session.proxy || fallbackProxyIntel
  const usageType = session.network?.usageType

  if (proxy.isProxy) {
    const proxyType = proxy.proxyType ? ` (${proxy.proxyType})` : ''
    const threat = proxy.threat ? ` - threat: ${proxy.threat}` : ''
    // ponytail: data annotations stay literal; only the base sentence is translated
    return T(t, 'INTEL.REASON_PROXY', 'Open proxy traffic detected') + `${proxyType}${threat}`
  }

  if (proxy.confidence === 'unknown') {
    return T(t, 'INTEL.REASON_INCOMPLETE', 'Proxy intelligence is incomplete for this IP; verify behavior before trusting this device')
  }

  if (usageType && (usageType.toLowerCase().includes('data center') || usageType.toLowerCase().includes('hosting'))) {
    return T(t, 'INTEL.REASON_DATACENTER', 'Session came from {{usageType}}; this is often automation infrastructure', { usageType })
  }

  return T(t, 'INTEL.REASON_CLEAN', 'No proxy abuse indicators detected from current IP intelligence')
}

export function getSessionNetworkSummary(session: SessionIntelShape, t?: IntelTranslator): string {
  const network = session.network || fallbackNetworkIntel
  const primary = [network.asn, network.as].filter(Boolean).join(' • ')
  const secondary = [network.usageType, network.isp, network.domain].filter(Boolean).join(' • ')
  const value = [primary, secondary].filter(Boolean).join(' • ')
  if (value) {
    return value
  }
  if (isIntelligenceSkipped(session)) {
    return T(t, 'INTEL.PRIVATE_ADDRESS', 'Private or reserved address')
  }
  return T(t, 'INTEL.NETWORK_UNAVAILABLE', 'Network intelligence unavailable')
}

export function getSessionProxySummary(session: SessionIntelShape, t?: IntelTranslator): string {
  const proxy = session.proxy || fallbackProxyIntel
  if (!proxy.isProxy) {
    if (proxy.confidence === 'unknown') {
      // "unknown" and "never asked" are different answers, and only one of them
      // is a reason to distrust the device.
      if (isIntelligenceSkipped(session)) {
        return T(t, 'INTEL.PRIVATE_ADDRESS', 'Private or reserved address')
      }
      return T(t, 'INTEL.PROXY_UNKNOWN', 'Proxy status unknown')
    }
    return T(t, 'INTEL.PROXY_NONE', 'No open proxy detected')
  }

  const details = [proxy.proxyType, proxy.provider, proxy.threat].filter(Boolean).join(' • ')
  return T(t, 'INTEL.PROXY_DETECTED', 'Proxy detected') + (details ? `: ${details}` : '')
}

function cleanNullableString(value: unknown): string | null {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.toLowerCase() === 'unknown') {
    return null
  }
  return normalized
}

function isIntelligencePending(session: SessionIntelShape): boolean {
  return String(session.intelligenceStatus || '').trim().toLowerCase() === 'pending'
}

/**
 * The lookup was deliberately not attempted (non-routable address). Distinct from
 * `no-match`, where a provider was asked and had no answer.
 *
 * @param {SessionIntelShape} session session intelligence fields
 * @return {boolean} true when enrichment was skipped by design
 */
function isIntelligenceSkipped(session: SessionIntelShape): boolean {
  return String(session.intelligenceStatus || '').trim().toLowerCase() === 'skipped'
}
