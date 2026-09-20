import { describe, expect, test } from 'bun:test'
import { getApps } from 'firebase-admin/app'

describe('firebase admin bootstrap', () => {
  test('importing it is side-effect free and does not throw', async () => {
    // The regression this guards: the function's own config module threw at IMPORT
    // time under Bun ESM, because it reached for __dirname at module scope.
    const before = getApps().length
    const mod = await import('./firebase')

    expect(getApps().length).toBe(before)
    expect(typeof mod.adminApp).toBe('function')
    expect(typeof mod.adminAuth).toBe('function')
  })

  test('resolves the database id, defaulting to easyscrape', async () => {
    const { DB_NAME } = await import('./firebase')

    expect(DB_NAME).toBe((process.env['DB_NAME'] || '').trim() || 'easyscrape')
  })
})
