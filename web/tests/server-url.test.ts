import {describe, expect, test} from 'bun:test'
import {serverUrl} from '../src/lib/server-url'

describe('serverUrl', () => {
  test('uses the frontend origin when a retired hosting value remains', () => {
    for (const value of ['https://13-210-42-0.sslip.io', 'https://app-13-210-42-0.sslip.io/', 'https://SSLIP.IO./api', undefined, '']) {
      expect(serverUrl(value)).toBe('')
    }
  })

  test('keeps explicit AWS and local development endpoints', () => {
    expect(serverUrl('https://13.210.42.0/')).toBe('https://13.210.42.0')
    expect(serverUrl('http://localhost:8791')).toBe('http://localhost:8791')
    expect(serverUrl('https://example.cloudfront.net')).toBe('https://example.cloudfront.net')
  })
})
