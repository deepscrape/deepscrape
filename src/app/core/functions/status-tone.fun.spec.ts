import { CrawlOperationStatus } from '../enum'
import { statusBadgeClass, statusTone } from './status-tone.fun'

describe('status-tone.fun', () => {
  const everyStatus = Object.values(CrawlOperationStatus)

  it('gives every enum status a distinct, non-empty tone', () => {
    for (const status of everyStatus) {
      const tone = statusTone(status)
      expect(tone.bg).withContext(status).toContain('bg-')
      expect(tone.text).withContext(status).toContain('text-')
      expect(tone.dot).withContext(status).toContain('bg-')
    }
  })

  it('never returns an interpolated class name', () => {
    for (const status of everyStatus) {
      const tone = statusTone(status)
      expect(tone.bg).not.toContain('${')
      expect(tone.text).not.toContain('${')
      expect(tone.dot).not.toContain('${')
    }
  })

  it('marks a failure with the failure accent and a success with the success accent', () => {
    expect(statusTone(CrawlOperationStatus.FAILED).bg).toContain('rose')
    expect(statusTone(CrawlOperationStatus.COMPLETED).bg).toContain('emerald')
  })

  it('marks work in flight with the live accent', () => {
    expect(statusTone(CrawlOperationStatus.IN_PROGRESS).dot).toContain('cyan')
    expect(statusTone(CrawlOperationStatus.STARTED).dot).toContain('cyan')
  })

  it('falls back to the neutral tone for a status this build does not know', () => {
    const unknown = statusTone('Something New')
    expect(unknown).toEqual(statusTone(CrawlOperationStatus.READY))
  })

  it('falls back to the neutral tone for a null or empty status', () => {
    expect(statusTone(null)).toEqual(statusTone(CrawlOperationStatus.READY))
    expect(statusTone('')).toEqual(statusTone(CrawlOperationStatus.READY))
    expect(statusTone(undefined)).toEqual(statusTone(CrawlOperationStatus.READY))
  })

  it('builds a complete pill class from the tone', () => {
    const cls = statusBadgeClass(CrawlOperationStatus.IN_PROGRESS)
    expect(cls).toContain('rounded-full')
    expect(cls).toContain('bg-cyan-50')
    expect(cls).toContain('text-cyan-800')
  })
})
