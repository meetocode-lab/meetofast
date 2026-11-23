import {
  buildUrlFromQueryParams,
  computeApdexAndJitter,
  computeJsonStructuralDiff,
  computeMyersLineDiff,
  damerauLevenshteinDistance,
  evaluateLatencyAnomaly,
  extractConsumedVariablesFromText,
  extractProducedVariablesFromScript,
  RadixSegmentTrie,
  rankSearchCandidates,
  reconcileUrlAndQueryParams,
  redactHighEntropySecrets,
  shannonEntropyBitsPerChar,
  sortRequestsByDependencyDag,
  syncPathVariablesFromUrl,
  syncQueryParamsFromUrl,
  TokenBucket,
} from '@meofast/shared'
import { describe, expect, it } from 'vitest'

describe('Meofast Core Algorithms Suite', () => {
  it("1. Kahn's Topological Sort orders variable producers ahead of consumers and detects cycles", () => {
    const items = [
      {
        id: 'get-profile',
        originalIndex: 0,
        producedVars: [],
        consumedVars: extractConsumedVariablesFromText('{{BASE_URL}}/me Bearer {{accessToken}}'),
      },
      {
        id: 'health-check',
        originalIndex: 1,
        producedVars: [],
        consumedVars: ['BASE_URL'],
      },
      {
        id: 'post-login',
        originalIndex: 2,
        producedVars: extractProducedVariablesFromScript(
          'bru.setEnvVar("accessToken", res.body.token);',
        ),
        consumedVars: ['BASE_URL'],
      },
    ]

    const sorted = sortRequestsByDependencyDag(items)
    expect(sorted.reordered).toBe(true)
    expect(sorted.hasCycle).toBe(false)
    const ids = sorted.ordered.map((i) => i.id)
    expect(ids.indexOf('post-login')).toBeLessThan(ids.indexOf('get-profile'))

    const cyclic = sortRequestsByDependencyDag([
      { id: 'a', originalIndex: 0, producedVars: ['tokA'], consumedVars: ['tokB'] },
      { id: 'b', originalIndex: 1, producedVars: ['tokB'], consumedVars: ['tokA'] },
    ])
    expect(cyclic.hasCycle).toBe(true)
    expect(cyclic.ordered).toHaveLength(2)
  })

  it("2. Myers' O((N+M)D) Line Diff & Structural JSON AST Diff isolate exact edits", () => {
    const before = ['{', '  "id": 1,', '  "name": "Meofast",', '  "active": true', '}'].join('\n')
    const after = [
      '{',
      '  "version": "2.0",',
      '  "id": 1,',
      '  "name": "Meofast",',
      '  "active": true',
      '}',
    ].join('\n')

    const diff = computeMyersLineDiff(before, after)
    expect(diff.filter((d) => d.type === 'added')).toHaveLength(1)
    expect(diff.filter((d) => d.type === 'removed')).toHaveLength(0)
    expect(diff.filter((d) => d.type === 'same')).toHaveLength(5)

    const astChanges = computeJsonStructuralDiff(
      { id: 1, role: 'viewer', legacy: true },
      { id: '1', role: 'admin', extra: 42 },
    )
    expect(astChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'id', kind: 'type_changed' }),
        expect.objectContaining({ path: 'role', kind: 'modified' }),
        expect.objectContaining({ path: 'legacy', kind: 'removed' }),
        expect.objectContaining({ path: 'extra', kind: 'added' }),
      ]),
    )
  })

  it("3. EWMA + Welford's Online Z-Score detects latency spikes and computes Apdex", () => {
    const baseline = [38, 41, 39, 42, 40, 37, 41, 40]
    const normalProbe = evaluateLatencyAnomaly(baseline, 44)
    expect(normalProbe.isAnomaly).toBe(false)

    const spikeProbe = evaluateLatencyAnomaly(baseline, 410)
    expect(spikeProbe.isAnomaly).toBe(true)
    expect(spikeProbe.zScore).toBeGreaterThanOrEqual(3)

    const { apdexScore, jitterMs } = computeApdexAndJitter([50, 60, 70, 500], 0, 200)
    // 3 satisfied + 1 tolerating (0.5) = 3.5 / 4 = 0.88
    expect(apdexScore).toBe(0.88)
    expect(jitterMs).toBeGreaterThan(0)
  })

  it('4. Okapi BM25 + Damerau-Levenshtein + Fuzzy Subsequence handles typos and abbreviations', () => {
    expect(damerauLevenshteinDistance('bsae_url', 'base_url')).toBe(1)

    const docs = [
      { id: '1', title: 'GET List Webhook Events', url: '/v1/webhooks' },
      { id: '2', title: 'POST Create User Token', url: '/v1/users/token' },
      { id: '3', title: 'DELETE Revoke Session', url: '/v1/sessions/:id' },
    ]

    const fuzzyHit = rankSearchCandidates(docs, 'usr tokn', (d) => ({
      primary: d.title,
      secondary: d.url,
    }))
    expect(fuzzyHit[0]?.id).toBe('2')

    const typoHit = rankSearchCandidates(docs, 'revke sesion', (d) => ({
      primary: d.title,
      secondary: d.url,
    }))
    expect(typoHit[0]?.id).toBe('3')
  })

  it('5. Shannon Entropy & Pattern Automaton redacts JWTs, API keys, and high-entropy tokens', () => {
    const fakeJwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkRhdmluIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    expect(shannonEntropyBitsPerChar(fakeJwt)).toBeGreaterThan(4.0)

    const rawPayload = JSON.stringify({
      status: 'authenticated',
      access_token: 'xK9pQ2mZ8vN4rT7wL1yB6cF3hJ5sD0gA',
      jwt: fakeJwt,
    })

    const sanitized = redactHighEntropySecrets(rawPayload)
    expect(sanitized).toContain('"status":"authenticated"')
    expect(sanitized).not.toContain('xK9pQ2mZ8vN4rT7wL1yB6cF3hJ5sD0gA')
    expect(sanitized).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')
    expect(sanitized).toContain('••••••')
  })

  it('6. Radix Segment Trie enforces static > :param > *wildcard priority & Token Bucket limits bursts', () => {
    const trie = new RadixSegmentTrie<string>()
    trie.insert('/users/*rest', 'wildcard-route')
    trie.insert('/users/:userId', 'param-route')
    trie.insert('/users/me', 'static-route')

    expect(trie.match('/users/me')).toEqual({ value: 'static-route', params: {} })
    expect(trie.match('/users/42')).toEqual({
      value: 'param-route',
      params: { userId: '42' },
    })
    expect(trie.match('/users/42/orders/99')).toEqual({
      value: 'wildcard-route',
      params: { rest: '42/orders/99' },
    })

    const t0 = 1_000_000
    const bucket = new TokenBucket(2, 2, t0) // 2 req/sec, burst 2
    expect(bucket.tryConsume(1, t0).allowed).toBe(true)
    expect(bucket.tryConsume(1, t0).allowed).toBe(true)
    const limited = bucket.tryConsume(1, t0)
    expect(limited.allowed).toBe(false)
    expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    // After 600ms at 2 tokens/sec (+1.2 tokens), 1 request is allowed again
    expect(bucket.tryConsume(1, t0 + 600).allowed).toBe(true)
  })

  it('7. Two-Way URL <-> Query Params & Path Variables Sync avoids duplicates and preserves templates', () => {
    const openMeteoUrl =
      'https://api.open-meteo.com/v1/forecast?latitude=-6.2&longitude=106.8&current=temperature_2m,relative_humidity_2m'

    // Reconciles URL with stale/partial Params table without duplicating keys
    const reconciled = reconcileUrlAndQueryParams(openMeteoUrl, [
      { id: 'p1', key: 'latitude', value: '-6.2', description: '', enabled: true },
      { id: 'p2', key: 'longitude', value: '', description: '', enabled: true },
      { id: 'p3', key: 'timezone', value: 'Asia/Jakarta', description: '', enabled: false },
    ])

    expect(reconciled.url).toBe(openMeteoUrl)
    expect(reconciled.queryParams.filter((p) => p.enabled)).toEqual([
      expect.objectContaining({ id: 'p1', key: 'latitude', value: '-6.2', enabled: true }),
      expect.objectContaining({ id: 'p2', key: 'longitude', value: '106.8', enabled: true }),
      expect.objectContaining({
        key: 'current',
        value: 'temperature_2m,relative_humidity_2m',
        enabled: true,
      }),
    ])
    // Preserves disabled rows
    expect(reconciled.queryParams.find((p) => p.key === 'timezone')?.enabled).toBe(false)

    // Adding / enabling a param in Params table automatically updates the URL bar
    const withTimezoneEnabled = reconciled.queryParams.map((p) =>
      p.key === 'timezone' ? { ...p, enabled: true } : p,
    )
    const nextUrl = buildUrlFromQueryParams(reconciled.url, withTimezoneEnabled)
    expect(nextUrl).toBe(
      'https://api.open-meteo.com/v1/forecast?latitude=-6.2&longitude=106.8&current=temperature_2m,relative_humidity_2m&timezone=Asia/Jakarta',
    )

    // Typing {{variable}} in Params or URL preserves template tokens cleanly
    const withTemplate = syncQueryParamsFromUrl(
      '{{BASE_URL}}/v1/users/:userId?limit={{PAGE_SIZE}}#top',
      [],
    )
    expect(withTemplate).toEqual([
      expect.objectContaining({ key: 'limit', value: '{{PAGE_SIZE}}', enabled: true }),
    ])
    expect(
      buildUrlFromQueryParams('{{BASE_URL}}/v1/users/:userId?old=1#top', withTemplate),
    ).toBe('{{BASE_URL}}/v1/users/:userId?limit={{PAGE_SIZE}}#top')

    // Extracts :pathVariables without matching :port numbers
    const pathVars = syncPathVariablesFromUrl(
      'http://localhost:4780/v1/users/:userId/orders/:orderId?limit=10',
      [{ id: 'pv1', key: 'userId', value: '42', description: '', enabled: true }],
    )
    expect(pathVars).toEqual([
      expect.objectContaining({ id: 'pv1', key: 'userId', value: '42', enabled: true }),
      expect.objectContaining({ key: 'orderId', value: '', enabled: true }),
    ])
  })
})
