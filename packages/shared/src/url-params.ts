import type { KeyValueItem } from './index.js'

export interface SplitUrlParts {
  base: string
  query: string | null
  hash: string
}

function defaultMakeId(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `kv-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function splitUrlQueryAndHash(rawUrl: string): SplitUrlParts {
  const hashIdx = rawUrl.indexOf('#')
  const withoutHash = hashIdx >= 0 ? rawUrl.slice(0, hashIdx) : rawUrl
  const hash = hashIdx >= 0 ? rawUrl.slice(hashIdx) : ''

  const qIdx = withoutHash.indexOf('?')
  if (qIdx === -1) {
    return { base: withoutHash, query: null, hash }
  }
  return {
    base: withoutHash.slice(0, qIdx),
    query: withoutHash.slice(qIdx + 1),
    hash,
  }
}

export function decodeQueryComponentSafe(raw: string): string {
  if (!raw.includes('%')) return raw
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw.replace(/%[0-9A-Fa-f]{2}/g, (match) => {
      try {
        return decodeURIComponent(match)
      } catch {
        return match
      }
    })
  }
}

export function encodeQueryComponentPreservingTemplates(raw: string): string {
  if (!raw) return ''
  return raw
    .split(/(\{\{[^}]*\}\})/g)
    .map((segment) => {
      if (segment.startsWith('{{') && segment.endsWith('}}')) {
        return segment
      }
      return segment
        .replace(/%(?![0-9A-Fa-f]{2})/g, '%25')
        .replace(/ /g, '%20')
        .replace(/&/g, '%26')
        .replace(/=/g, '%3D')
        .replace(/#/g, '%23')
    })
    .join('')
}

export function parseUrlQueryEntries(
  rawUrl: string,
): Array<{ key: string; value: string; hasEquals: boolean }> {
  const { query } = splitUrlQueryAndHash(rawUrl)
  if (!query) return []
  const entries: Array<{ key: string; value: string; hasEquals: boolean }> = []
  for (const part of query.split('&')) {
    if (!part) continue
    const eqIdx = part.indexOf('=')
    if (eqIdx === -1) {
      entries.push({
        key: decodeQueryComponentSafe(part),
        value: '',
        hasEquals: false,
      })
    } else {
      entries.push({
        key: decodeQueryComponentSafe(part.slice(0, eqIdx)),
        value: decodeQueryComponentSafe(part.slice(eqIdx + 1)),
        hasEquals: true,
      })
    }
  }
  return entries
}

/**
 * Updates the `queryParams` array from a raw URL string (URL -> Params table).
 * Reuses existing row IDs/descriptions where possible and preserves unchecked (`enabled: false`) rows.
 */
export function syncQueryParamsFromUrl(
  nextUrl: string,
  prevParams: KeyValueItem[],
  createId: () => string = defaultMakeId,
): KeyValueItem[] {
  const parsed = parseUrlQueryEntries(nextUrl)
  const enabledPool = prevParams
    .filter((p) => p.enabled)
    .map((item) => ({ item, used: false }))
  const disabledRows = prevParams.filter((p) => !p.enabled)

  const syncedEnabled: KeyValueItem[] = parsed.map((entry, idx) => {
    // 1. Prefer positional match if key or value matches (keeps React input focus/ID stable while typing)
    const positional = enabledPool[idx]
    if (
      positional &&
      !positional.used &&
      (positional.item.key === entry.key ||
        (entry.value !== '' && positional.item.value === entry.value))
    ) {
      positional.used = true
      return {
        ...positional.item,
        key: entry.key,
        value: entry.value,
        enabled: true,
      }
    }

    // 2. Otherwise match first unused enabled row with the same key
    const byKey = enabledPool.find((c) => !c.used && c.item.key === entry.key)
    if (byKey) {
      byKey.used = true
      return {
        ...byKey.item,
        key: entry.key,
        value: entry.value,
        enabled: true,
      }
    }

    // 3. Fallback to positional unused row when renaming the sole/positional key in the URL
    if (positional && !positional.used && enabledPool.length === parsed.length) {
      positional.used = true
      return {
        ...positional.item,
        key: entry.key,
        value: entry.value,
        enabled: true,
      }
    }

    return {
      id: createId(),
      key: entry.key,
      value: entry.value,
      description: '',
      enabled: true,
    }
  })

  return [...syncedEnabled, ...disabledRows]
}

/**
 * Rebuilds the raw URL string from the `queryParams` table (Params table -> URL).
 * Preserves base URL (including `{{variables}}` and `:pathParams`) and `#hash`.
 */
export function buildUrlFromQueryParams(
  currentUrl: string,
  nextParams: KeyValueItem[],
): string {
  const { base, hash } = splitUrlQueryAndHash(currentUrl)
  const activeSegments: string[] = []

  for (const param of nextParams) {
    if (!param.enabled) continue
    const rawKey = param.key.trim()
    if (!rawKey && !param.value) continue
    const encKey = encodeQueryComponentPreservingTemplates(rawKey)
    const encVal = encodeQueryComponentPreservingTemplates(param.value)
    if (encKey && encVal !== '') {
      activeSegments.push(`${encKey}=${encVal}`)
    } else if (encKey) {
      activeSegments.push(encKey)
    }
  }

  if (activeSegments.length === 0) {
    return `${base}${hash}`
  }
  return `${base}?${activeSegments.join('&')}${hash}`
}

/**
 * Reconciles `url` and `queryParams` when opening/loading/rehydrating a tab or generating snippets
 * so both sides contain the exact same active parameters without duplicates.
 */
export function reconcileUrlAndQueryParams(
  rawUrl: string,
  queryParams: KeyValueItem[],
  createId: () => string = defaultMakeId,
): { url: string; queryParams: KeyValueItem[] } {
  const urlEntries = parseUrlQueryEntries(rawUrl)
  const trailingBlankRows = queryParams.filter(
    (p) => p.enabled && p.key === '' && p.value === '',
  )

  if (urlEntries.length > 0) {
    const fromUrl = syncQueryParamsFromUrl(rawUrl, queryParams, createId)
    const urlKeySet = new Set(urlEntries.map((e) => e.key))

    // Preserve any extra enabled params whose keys were not in the URL yet (and have non-empty key+value)
    const extraEnabled = queryParams.filter(
      (p) => p.enabled && p.key.trim() !== '' && !urlKeySet.has(p.key.trim()),
    )

    const merged = [
      ...fromUrl.filter((p) => p.enabled),
      ...extraEnabled,
      ...fromUrl.filter((p) => !p.enabled),
      ...trailingBlankRows,
    ]
    const nextUrl =
      extraEnabled.length > 0 ? buildUrlFromQueryParams(rawUrl, merged) : rawUrl
    return {
      url: nextUrl,
      queryParams: merged,
    }
  }

  const hasEnabledParams = queryParams.some((p) => p.enabled && p.key.trim() !== '')
  if (hasEnabledParams) {
    return {
      url: buildUrlFromQueryParams(rawUrl, queryParams),
      queryParams,
    }
  }

  return { url: rawUrl, queryParams }
}

/**
 * Extracts `:param` path variable keys from the URL path (ignoring port numbers like `:4780`)
 * and syncs them with existing `pathVariables` while preserving existing values.
 */
export function syncPathVariablesFromUrl(
  rawUrl: string,
  prevPathVars: KeyValueItem[],
  createId: () => string = defaultMakeId,
): KeyValueItem[] {
  const { base } = splitUrlQueryAndHash(rawUrl)
  // Strip scheme://authority or leading {{BASE_URL}} so port numbers (:4780) are never matched
  const pathOnly = base
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/i, '')
    .replace(/^\{\{[^}]+\}\}/, '')

  const keysInPath: string[] = []
  const seen = new Set<string>()
  const regex = /\/:([a-zA-Z_][a-zA-Z0-9_-]*)/g
  let match: RegExpExecArray | null = regex.exec(pathOnly)
  while (match) {
    const key = match[1]!
    if (!seen.has(key)) {
      seen.add(key)
      keysInPath.push(key)
    }
    match = regex.exec(pathOnly)
  }

  if (keysInPath.length === 0) {
    return prevPathVars
  }

  const byKey = new Map(prevPathVars.map((item) => [item.key, item]))
  return keysInPath.map((key) => {
    const existing = byKey.get(key)
    if (existing) return existing
    return {
      id: createId(),
      key,
      value: '',
      description: '',
      enabled: true,
    }
  })
}
