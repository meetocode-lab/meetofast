// ============================================================================
// Meofast Core Algorithmic Engine (Pure TypeScript, Zero External Dependencies)
// 1. Kahn's Topological Sort + Cycle Detection (Request Dependency DAG)
// 2. Myers' O((N+M)D) / LCS Line Diff + Structural JSON AST Diff
// 3. EWMA + Welford's Online Variance (Z-Score Anomaly) + Apdex Score
// 4. Okapi BM25 + Damerau-Levenshtein + Fuzzy Subsequence Ranking
// 5. Shannon Entropy H(X) + Pattern Automaton Secret Redactor
// 6. Radix Segment Trie Router + Token Bucket Rate Limiter
// ============================================================================

// ----------------------------------------------------------------------------
// 1. Kahn's Topological Sort + Cycle Detection (Request Dependency DAG)
// ----------------------------------------------------------------------------

export interface DagRequestDescriptor {
  id: string
  originalIndex: number
  producedVars: string[]
  consumedVars: string[]
}

export interface DagSortResult<T extends DagRequestDescriptor> {
  ordered: T[]
  reordered: boolean
  hasCycle: boolean
  edgesCount: number
}

const TEMPLATE_TOKEN_REGEX = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g
const SCRIPT_SET_VAR_REGEX =
  /\b(?:pm\.(?:environment|variables)\.set|mf\.(?:environment|variables)\.set|bru\.set(?:Env)?Var)\s*\(\s*['"`]([^'"`]+)['"`]/g

export function extractConsumedVariablesFromText(text: string): string[] {
  const out = new Set<string>()
  let m = TEMPLATE_TOKEN_REGEX.exec(text)
  while (m !== null) {
    const key = (m[1] ?? '').trim()
    if (key && !key.startsWith('$')) {
      out.add(key)
    }
    m = TEMPLATE_TOKEN_REGEX.exec(text)
  }
  TEMPLATE_TOKEN_REGEX.lastIndex = 0
  return Array.from(out)
}

export function extractProducedVariablesFromScript(script: string): string[] {
  const out = new Set<string>()
  let m = SCRIPT_SET_VAR_REGEX.exec(script)
  while (m !== null) {
    const key = (m[1] ?? '').trim()
    if (key) out.add(key)
    m = SCRIPT_SET_VAR_REGEX.exec(script)
  }
  SCRIPT_SET_VAR_REGEX.lastIndex = 0
  return Array.from(out)
}

export function sortRequestsByDependencyDag<T extends DagRequestDescriptor>(
  items: T[],
): DagSortResult<T> {
  if (items.length <= 1) {
    return { ordered: [...items], reordered: false, hasCycle: false, edgesCount: 0 }
  }

  const byId = new Map<string, T>()
  const producersByVar = new Map<string, string[]>()

  for (const item of items) {
    byId.set(item.id, item)
    for (const v of item.producedVars) {
      const k = v.trim()
      if (!k) continue
      const list = producersByVar.get(k) ?? []
      if (!list.includes(item.id)) list.push(item.id)
      producersByVar.set(k, list)
    }
  }

  const adjacency = new Map<string, Set<string>>()
  const inDegree = new Map<string, number>()
  for (const item of items) {
    adjacency.set(item.id, new Set())
    inDegree.set(item.id, 0)
  }

  let edgesCount = 0
  for (const consumer of items) {
    for (const neededVar of consumer.consumedVars) {
      const producers = producersByVar.get(neededVar.trim()) ?? []
      for (const producerId of producers) {
        if (producerId === consumer.id) continue
        const neighbors = adjacency.get(producerId)!
        if (!neighbors.has(consumer.id)) {
          neighbors.add(consumer.id)
          inDegree.set(consumer.id, (inDegree.get(consumer.id) ?? 0) + 1)
          edgesCount += 1
        }
      }
    }
  }

  if (edgesCount === 0) {
    return { ordered: [...items], reordered: false, hasCycle: false, edgesCount: 0 }
  }

  // Kahn's Algorithm with stable min-order tie-breaking
  const ready: T[] = items
    .filter((item) => (inDegree.get(item.id) ?? 0) === 0)
    .sort((a, b) => a.originalIndex - b.originalIndex)

  const ordered: T[] = []
  const placedIds = new Set<string>()

  while (ready.length > 0) {
    const current = ready.shift()!
    ordered.push(current)
    placedIds.add(current.id)

    for (const nextId of adjacency.get(current.id) ?? []) {
      const nextDeg = (inDegree.get(nextId) ?? 1) - 1
      inDegree.set(nextId, nextDeg)
      if (nextDeg === 0) {
        const nextItem = byId.get(nextId)!
        ready.push(nextItem)
        ready.sort((a, b) => a.originalIndex - b.originalIndex)
      }
    }
  }

  const hasCycle = ordered.length < items.length
  if (hasCycle) {
    // Append cyclic nodes in their original order so execution never stalls
    for (const item of items) {
      if (!placedIds.has(item.id)) {
        ordered.push(item)
      }
    }
  }

  const reordered = ordered.some((item, idx) => item.id !== items[idx]?.id)
  return { ordered, reordered, hasCycle, edgesCount }
}

// ----------------------------------------------------------------------------
// 2. Myers' Shortest Edit Script / LCS Line Diff + Structural JSON AST Diff
// ----------------------------------------------------------------------------

export interface DiffLineResult {
  type: 'same' | 'added' | 'removed'
  text: string
}

export function computeMyersLineDiff(beforeText: string, afterText: string): DiffLineResult[] {
  if (beforeText === afterText) {
    return beforeText.split('\n').map((text) => ({ type: 'same', text }))
  }

  const a = beforeText.split('\n')
  const b = afterText.split('\n')
  const n = a.length
  const m = b.length

  // Guard huge payloads (> 1200 lines) with anchored prefix/suffix + LCS window
  const MAX_MATRIX = 900
  let prefixLen = 0
  while (prefixLen < n && prefixLen < m && a[prefixLen] === b[prefixLen]) {
    prefixLen += 1
  }

  let suffixLen = 0
  while (
    suffixLen < n - prefixLen &&
    suffixLen < m - prefixLen &&
    a[n - 1 - suffixLen] === b[m - 1 - suffixLen]
  ) {
    suffixLen += 1
  }

  const prefix: DiffLineResult[] = a
    .slice(0, prefixLen)
    .map((text) => ({ type: 'same', text }))
  const suffix: DiffLineResult[] = a
    .slice(n - suffixLen)
    .map((text) => ({ type: 'same', text }))

  const midA = a.slice(prefixLen, n - suffixLen)
  const midB = b.slice(prefixLen, m - suffixLen)

  if (midA.length === 0 && midB.length === 0) {
    return [...prefix, ...suffix]
  }
  if (midA.length === 0) {
    return [...prefix, ...midB.map((text) => ({ type: 'added' as const, text })), ...suffix]
  }
  if (midB.length === 0) {
    return [...prefix, ...midA.map((text) => ({ type: 'removed' as const, text })), ...suffix]
  }

  if (midA.length > MAX_MATRIX || midB.length > MAX_MATRIX) {
    return [
      ...prefix,
      ...midA.slice(0, MAX_MATRIX).map((text) => ({ type: 'removed' as const, text })),
      ...midB.slice(0, MAX_MATRIX).map((text) => ({ type: 'added' as const, text })),
      ...suffix,
    ]
  }

  // Myers' O((N+M)D) Shortest Edit Graph
  const maxD = midA.length + midB.length
  const v = new Map<number, number>()
  v.set(1, 0)
  const trace: Array<Map<number, number>> = []

  let finished = false
  for (let d = 0; d <= maxD && !finished; d += 1) {
    const snapshot = new Map<number, number>()
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
        x = v.get(k + 1) ?? 0
      } else {
        x = (v.get(k - 1) ?? 0) + 1
      }
      let y = x - k
      while (x < midA.length && y < midB.length && midA[x] === midB[y]) {
        x += 1
        y += 1
      }
      v.set(k, x)
      snapshot.set(k, x)
      if (x >= midA.length && y >= midB.length) {
        finished = true
        break
      }
    }
    trace.push(snapshot)
  }

  // Backtrack Myers trace to build minimal edit script
  const middleOps: DiffLineResult[] = []
  let x = midA.length
  let y = midB.length

  for (let d = trace.length - 1; d > 0; d -= 1) {
    const prevV = trace[d - 1]!
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && (prevV.get(k - 1) ?? 0) < (prevV.get(k + 1) ?? 0))) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = prevV.get(prevK) ?? 0
    const prevY = prevX - prevK

    while (x > prevX && y > prevY) {
      middleOps.push({ type: 'same', text: midA[x - 1]! })
      x -= 1
      y -= 1
    }

    if (x === prevX) {
      middleOps.push({ type: 'added', text: midB[y - 1]! })
      y -= 1
    } else {
      middleOps.push({ type: 'removed', text: midA[x - 1]! })
      x -= 1
    }
  }

  while (x > 0 && y > 0) {
    middleOps.push({ type: 'same', text: midA[x - 1]! })
    x -= 1
    y -= 1
  }
  while (y > 0) {
    middleOps.push({ type: 'added', text: midB[y - 1]! })
    y -= 1
  }
  while (x > 0) {
    middleOps.push({ type: 'removed', text: midA[x - 1]! })
    x -= 1
  }

  middleOps.reverse()
  return [...prefix, ...middleOps, ...suffix]
}

export interface JsonStructuralChange {
  path: string
  kind: 'added' | 'removed' | 'type_changed' | 'modified'
  beforeType?: string
  afterType?: string
}

function jsonValueKind(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

export function computeJsonStructuralDiff(
  beforeVal: unknown,
  afterVal: unknown,
  basePath = '$',
  depth = 0,
): JsonStructuralChange[] {
  if (depth > 8) return []
  const tA = jsonValueKind(beforeVal)
  const tB = jsonValueKind(afterVal)

  if (tA !== tB) {
    return [{ path: basePath, kind: 'type_changed', beforeType: tA, afterType: tB }]
  }

  if (tA === 'object') {
    const objA = beforeVal as Record<string, unknown>
    const objB = afterVal as Record<string, unknown>
    const allKeys = new Set([...Object.keys(objA), ...Object.keys(objB)])
    const changes: JsonStructuralChange[] = []

    for (const k of allKeys) {
      const childPath = basePath === '$' ? k : `${basePath}.${k}`
      const inA = Object.prototype.hasOwnProperty.call(objA, k)
      const inB = Object.prototype.hasOwnProperty.call(objB, k)
      if (!inA && inB) {
        changes.push({ path: childPath, kind: 'added', afterType: jsonValueKind(objB[k]) })
      } else if (inA && !inB) {
        changes.push({ path: childPath, kind: 'removed', beforeType: jsonValueKind(objA[k]) })
      } else {
        changes.push(...computeJsonStructuralDiff(objA[k], objB[k], childPath, depth + 1))
      }
      if (changes.length >= 40) break
    }
    return changes
  }

  if (tA === 'array') {
    const arrA = beforeVal as unknown[]
    const arrB = afterVal as unknown[]
    const maxCheck = Math.min(Math.max(arrA.length, arrB.length), 15)
    const changes: JsonStructuralChange[] = []
    for (let i = 0; i < maxCheck; i += 1) {
      const childPath = `${basePath}[${i}]`
      if (i >= arrA.length) {
        changes.push({ path: childPath, kind: 'added', afterType: jsonValueKind(arrB[i]) })
      } else if (i >= arrB.length) {
        changes.push({ path: childPath, kind: 'removed', beforeType: jsonValueKind(arrA[i]) })
      } else {
        changes.push(...computeJsonStructuralDiff(arrA[i], arrB[i], childPath, depth + 1))
      }
      if (changes.length >= 40) break
    }
    return changes
  }

  if (!Object.is(beforeVal, afterVal)) {
    return [{ path: basePath, kind: 'modified', beforeType: tA, afterType: tB }]
  }

  return []
}

// ----------------------------------------------------------------------------
// 3. EWMA + Welford's Online Variance (Z-Score Anomaly) + Apdex Score
// ----------------------------------------------------------------------------

export interface LatencyAnomalyTelemetry {
  ewmaMs: number
  meanMs: number
  stdDevMs: number
  zScore: number
  isAnomaly: boolean
}

/**
 * Evaluates whether `latestMs` is a statistical latency spike relative to `priorSamplesChronological`
 * using Welford's single-pass online mean/variance and Exponentially Weighted Moving Average (EWMA).
 */
export function evaluateLatencyAnomaly(
  priorSamplesChronological: number[],
  latestMs: number,
  alpha = 0.3,
): LatencyAnomalyTelemetry {
  if (priorSamplesChronological.length === 0) {
    return {
      ewmaMs: latestMs,
      meanMs: latestMs,
      stdDevMs: 0,
      zScore: 0,
      isAnomaly: false,
    }
  }

  // Welford's Online Algorithm for numerical stability
  let count = 0
  let mean = 0
  let m2 = 0
  let ewma = priorSamplesChronological[0]!

  for (let i = 0; i < priorSamplesChronological.length; i += 1) {
    const x = priorSamplesChronological[i]!
    count += 1
    const delta = x - mean
    mean += delta / count
    const delta2 = x - mean
    m2 += delta * delta2
    if (i > 0) {
      ewma = alpha * x + (1 - alpha) * ewma
    }
  }

  const variance = count > 1 ? m2 / (count - 1) : 0
  const stdDev = Math.sqrt(variance)
  const effectiveStd = Math.max(stdDev, Math.max(8, ewma * 0.15))
  const zScore = Number(((latestMs - mean) / effectiveStd).toFixed(2))

  const isAnomaly =
    count >= 4 &&
    zScore >= 3.0 &&
    latestMs > ewma * 1.8 &&
    latestMs - ewma >= 60

  const updatedEwma = Math.round(alpha * latestMs + (1 - alpha) * ewma)

  return {
    ewmaMs: updatedEwma,
    meanMs: Math.round(mean),
    stdDevMs: Math.round(stdDev),
    zScore,
    isAnomaly,
  }
}

export function computeApdexAndJitter(
  latenciesMs: number[],
  failedCount: number,
  satisfiedThresholdMs = 300,
): { apdexScore: number; jitterMs: number } {
  const total = latenciesMs.length
  if (total === 0) return { apdexScore: 1, jitterMs: 0 }

  // Welford standard deviation for jitter
  let n = 0
  let mean = 0
  let m2 = 0
  let satisfied = 0
  let tolerating = 0
  const toleratingLimit = satisfiedThresholdMs * 4

  for (const ms of latenciesMs) {
    n += 1
    const d1 = ms - mean
    mean += d1 / n
    m2 += d1 * (ms - mean)

    if (ms <= satisfiedThresholdMs) satisfied += 1
    else if (ms <= toleratingLimit) tolerating += 1
  }

  // Failed requests always count as Frustrated in Apdex specification
  const effectiveSatisfied = Math.max(0, satisfied - failedCount)
  const rawApdex = (effectiveSatisfied + 0.5 * tolerating) / total
  const apdexScore = Number(Math.min(1, Math.max(0, rawApdex)).toFixed(2))
  const jitterMs = n > 1 ? Math.round(Math.sqrt(m2 / (n - 1))) : 0

  return { apdexScore, jitterMs }
}

// ----------------------------------------------------------------------------
// 4. Okapi BM25 + Damerau-Levenshtein + Fuzzy Subsequence Ranking
// ----------------------------------------------------------------------------

export function damerauLevenshteinDistance(aRaw: string, bRaw: string, maxCap = 6): number {
  const a = aRaw.toLowerCase()
  const b = bRaw.toLowerCase()
  if (a === b) return 0
  const lenA = a.length
  const lenB = b.length
  if (Math.abs(lenA - lenB) > maxCap) return maxCap + 1
  if (lenA === 0) return lenB
  if (lenB === 0) return lenA

  const dp: number[][] = Array.from({ length: lenA + 1 }, () =>
    new Array<number>(lenB + 1).fill(0),
  )
  for (let i = 0; i <= lenA; i += 1) dp[i]![0] = i
  for (let j = 0; j <= lenB; j += 1) dp[0]![j] = j

  for (let i = 1; i <= lenA; i += 1) {
    let rowMin = maxCap + 1
    for (let j = 1; j <= lenB; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let val = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      )
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        val = Math.min(val, dp[i - 2]![j - 2]! + 1)
      }
      dp[i]![j] = val
      if (val < rowMin) rowMin = val
    }
    if (rowMin > maxCap) return maxCap + 1
  }

  return dp[lenA]![lenB]!
}

export function fuzzySubsequenceScore(queryRaw: string, targetRaw: string): number {
  const q = queryRaw.toLowerCase().trim()
  const t = targetRaw.toLowerCase()
  if (!q) return 1
  if (t === q) return 120
  if (t.startsWith(q)) return 95
  if (t.includes(q)) return 75

  // Contiguous / boundary-aware subsequence scan (fzf-style)
  let qi = 0
  let streak = 0
  let score = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      const isBoundary =
        ti === 0 ||
        t[ti - 1] === '_' ||
        t[ti - 1] === '-' ||
        t[ti - 1] === '/' ||
        t[ti - 1] === ' ' ||
        (targetRaw[ti] !== undefined &&
          targetRaw[ti] === targetRaw[ti]!.toUpperCase() &&
          targetRaw[ti] !== targetRaw[ti]!.toLowerCase())
      streak += 1
      score += 8 + streak * 4 + (isBoundary ? 6 : 0)
      qi += 1
    } else {
      streak = 0
    }
  }

  if (qi === q.length) {
    return Math.min(70, score)
  }

  // Typo fallback via Damerau-Levenshtein on tokens
  const maxEdits = q.length >= 6 ? 2 : q.length >= 4 ? 1 : 0
  if (maxEdits > 0) {
    const tokens = t.split(/[^a-z0-9$]+/).filter(Boolean)
    for (const tok of tokens) {
      const dist = damerauLevenshteinDistance(q, tok.slice(0, q.length + 2), maxEdits)
      if (dist <= maxEdits) {
        return 42 - dist * 12
      }
    }
    const wholeDist = damerauLevenshteinDistance(q, t, maxEdits)
    if (wholeDist <= maxEdits) {
      return 45 - wholeDist * 12
    }
  }

  return 0
}

function tokenizeSearchTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9$]+/)
    .filter((tok) => tok.length > 0)
}

export function rankSearchCandidates<T>(
  items: T[],
  query: string,
  getSearchableText: (item: T) => { primary: string; secondary?: string; boost?: number },
  limit = 24,
): T[] {
  const qTrim = query.trim()
  if (!qTrim || items.length === 0) return items.slice(0, limit)

  const qTerms = tokenizeSearchTerms(qTrim)
  const k1 = 1.5
  const b = 0.75

  const docMeta = items.map((item) => {
    const { primary, secondary = '', boost = 1 } = getSearchableText(item)
    const fullText = `${primary} ${primary} ${secondary}` // 2x field weight on primary title
    const tokens = tokenizeSearchTerms(fullText)
    const freq = new Map<string, number>()
    for (const tok of tokens) {
      freq.set(tok, (freq.get(tok) ?? 0) + 1)
    }
    return { item, primary, secondary, boost, tokens, freq, len: Math.max(1, tokens.length) }
  })

  const avgDocLen =
    docMeta.reduce((sum, d) => sum + d.len, 0) / Math.max(1, docMeta.length)

  // Document frequency per query term (including prefix/typo match)
  const df = new Map<string, number>()
  for (const qt of qTerms) {
    let count = 0
    for (const doc of docMeta) {
      if (doc.tokens.some((dt) => dt.startsWith(qt) || damerauLevenshteinDistance(qt, dt, 1) <= 1)) {
        count += 1
      }
    }
    df.set(qt, count)
  }

  const N = docMeta.length
  const scored: Array<{ item: T; score: number }> = []

  for (const doc of docMeta) {
    let bm25 = 0
    for (const qt of qTerms) {
      let tf = doc.freq.get(qt) ?? 0
      if (tf === 0) {
        for (const [dt, c] of doc.freq.entries()) {
          if (dt.startsWith(qt)) {
            tf += c * 0.75
          } else if (qt.length >= 4 && damerauLevenshteinDistance(qt, dt, 1) <= 1) {
            tf += c * 0.5
          }
        }
      }
      if (tf > 0) {
        const nq = df.get(qt) ?? 0
        const idf = Math.log(1 + (N - nq + 0.5) / (nq + 0.5))
        const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.len / avgDocLen)))
        bm25 += idf * norm
      }
    }

    const fuzzyPrimary = fuzzySubsequenceScore(qTrim, doc.primary)
    const fuzzySecondary = doc.secondary ? fuzzySubsequenceScore(qTrim, doc.secondary) * 0.55 : 0
    const combined = (bm25 * 22 + Math.max(fuzzyPrimary, fuzzySecondary)) * doc.boost

    if (combined > 0) {
      scored.push({ item: doc.item, score: combined })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((s) => s.item)
}

// ----------------------------------------------------------------------------
// 5. Shannon Entropy H(X) + Pattern Automaton Secret Redactor
// ----------------------------------------------------------------------------

export function shannonEntropyBitsPerChar(str: string): number {
  if (!str) return 0
  const freq = new Map<string, number>()
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i]!
    freq.set(ch, (freq.get(ch) ?? 0) + 1)
  }
  const len = str.length
  let entropy = 0
  for (const count of freq.values()) {
    const p = count / len
    entropy -= p * Math.log2(p)
  }
  return entropy
}

const KNOWN_SECRET_PATTERNS: RegExp[] = [
  // JWT (header.payload.signature)
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // OpenAI / Anthropic / GitHub / Slack / Meofast PAT / AWS Access Key prefixes
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|mf_pat_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g,
  // Inline Authorization Bearer / Basic credentials inside logs or raw headers
  /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{14,})/gi,
]

const JSON_SENSITIVE_FIELD_REGEX =
  /("(?:access_token|refresh_token|id_token|client_secret|api_key|apiKey|secret|password|private_key|session_token)"\s*:\s*")([^"\r\n]{8,})(")/gi

export function redactHighEntropySecrets(text: string, explicitSecrets: string[] = []): string {
  if (!text) return text
  let out = text

  for (const secret of explicitSecrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join('••••••')
    }
  }

  for (const pattern of KNOWN_SECRET_PATTERNS) {
    out = out.replace(pattern, (full, prefixGroup?: string) => {
      if (prefixGroup && /^(bearer|basic)$/i.test(prefixGroup)) {
        return `${prefixGroup} ••••••`
      }
      return '••••••'
    })
  }

  out = out.replace(
    JSON_SENSITIVE_FIELD_REGEX,
    (full, openQuoteKey: string, val: string, closeQuote: string) => {
      if (val === '••••••' || val.startsWith('{{')) return full
      // Redact password fields unconditionally, or token/secret fields with medium-high entropy
      if (
        /password|secret|private_key/i.test(openQuoteKey) ||
        (val.length >= 16 && shannonEntropyBitsPerChar(val) >= 3.3)
      ) {
        return `${openQuoteKey}••••••${closeQuote}`
      }
      return full
    },
  )

  return out
}

// ----------------------------------------------------------------------------
// 6. Radix Segment Trie Router + Token Bucket Rate Limiter
// ----------------------------------------------------------------------------

interface TrieNode<T> {
  statics: Map<string, TrieNode<T>>
  paramChild: { paramName: string; node: TrieNode<T> } | null
  wildcardValue: { wildcardName: string; value: T } | null
  value: T | null
}

function createTrieNode<T>(): TrieNode<T> {
  return {
    statics: new Map(),
    paramChild: null,
    wildcardValue: null,
    value: null,
  }
}

export class RadixSegmentTrie<T> {
  private root: TrieNode<T> = createTrieNode<T>()

  insert(pattern: string, value: T): void {
    const segs = pattern
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean)

    let curr = this.root
    for (let i = 0; i < segs.length; i += 1) {
      const seg = segs[i]!
      if (seg === '*' || seg.startsWith('*')) {
        curr.wildcardValue = { wildcardName: seg.slice(1) || 'wildcard', value }
        return
      }
      if (seg.startsWith(':') || (seg.startsWith('{') && seg.endsWith('}'))) {
        const paramName = seg.startsWith(':') ? seg.slice(1) : seg.slice(1, -1)
        if (!curr.paramChild) {
          curr.paramChild = { paramName, node: createTrieNode<T>() }
        }
        curr = curr.paramChild.node
      } else {
        let next = curr.statics.get(seg)
        if (!next) {
          next = createTrieNode<T>()
          curr.statics.set(seg, next)
        }
        curr = next
      }
    }
    curr.value = value
  }

  match(actualPath: string): { value: T; params: Record<string, string> } | null {
    const segs = actualPath
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean)

    const search = (
      node: TrieNode<T>,
      idx: number,
      params: Record<string, string>,
    ): { value: T; params: Record<string, string> } | null => {
      if (idx === segs.length) {
        if (node.value !== null) {
          return { value: node.value, params }
        }
        if (node.wildcardValue !== null) {
          return {
            value: node.wildcardValue.value,
            params: { ...params, [node.wildcardValue.wildcardName]: '' },
          }
        }
        return null
      }

      const seg = segs[idx]!

      // Priority 1: Exact static segment match
      const staticNext = node.statics.get(seg)
      if (staticNext) {
        const res = search(staticNext, idx + 1, params)
        if (res) return res
      }

      // Priority 2: Parameterized segment (:id or {id})
      if (node.paramChild) {
        const decoded = (() => {
          try {
            return decodeURIComponent(seg)
          } catch {
            return seg
          }
        })()
        const res = search(node.paramChild.node, idx + 1, {
          ...params,
          [node.paramChild.paramName]: decoded,
        })
        if (res) return res
      }

      // Priority 3: Catch-all wildcard (* or *filepath)
      if (node.wildcardValue !== null) {
        return {
          value: node.wildcardValue.value,
          params: {
            ...params,
            [node.wildcardValue.wildcardName]: segs.slice(idx).join('/'),
          },
        }
      }

      return null
    }

    return search(this.root, 0, {})
  }
}

export class TokenBucket {
  private tokens: number
  private lastRefillMs: number
  private readonly capacity: number
  private readonly refillPerMs: number

  constructor(ratePerSecond: number, burstCapacity?: number, initialNowMs = Date.now()) {
    const safeRate = Math.max(0.01, ratePerSecond)
    this.capacity = burstCapacity ?? Math.max(1, Math.ceil(safeRate))
    this.tokens = this.capacity
    this.refillPerMs = safeRate / 1000
    this.lastRefillMs = initialNowMs
  }

  private refill(nowMs: number): void {
    const elapsed = Math.max(0, nowMs - this.lastRefillMs)
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs)
      this.lastRefillMs = nowMs
    }
  }

  tryConsume(count = 1, nowMs = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    this.refill(nowMs)
    if (this.tokens >= count) {
      this.tokens -= count
      return { allowed: true, retryAfterSeconds: 0 }
    }
    const deficit = count - this.tokens
    const waitMs = deficit / this.refillPerMs
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) }
  }

  waitDelayMs(count = 1, nowMs = Date.now()): number {
    this.refill(nowMs)
    if (this.tokens >= count) {
      this.tokens -= count
      return 0
    }
    const deficit = count - this.tokens
    const waitMs = Math.ceil(deficit / this.refillPerMs)
    this.tokens = 0
    this.lastRefillMs = nowMs + waitMs
    return waitMs
  }
}
