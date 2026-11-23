import type { Context } from 'hono'
import { type RawBuilder, sql } from 'kysely'

export type SortDirection = 'asc' | 'desc'

export interface ParsedTableQuery {
  q: string
  tokens: string[]
  page: number
  pageSize: number
  offset: number
  sortBy: string | null
  sortDir: SortDirection
  hasPaginationParams: boolean
}

const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

export function parseTableQuery(c: Context, defaultPageSize = 10): ParsedTableQuery {
  const rawPage = c.req.query('page')
  const rawPageSize = c.req.query('pageSize')
  const rawQ = (c.req.query('q') ?? '').trim()
  const rawSortBy = (c.req.query('sortBy') ?? '').trim()
  const rawSortDir = (c.req.query('sortDir') ?? '').trim().toLowerCase()

  const page = Math.max(1, Number.parseInt(rawPage ?? '1', 10) || 1)
  const pageSize = Math.min(
    200,
    Math.max(1, Number.parseInt(rawPageSize ?? String(defaultPageSize), 10) || defaultPageSize),
  )
  const sortDir: SortDirection = rawSortDir === 'asc' ? 'asc' : 'desc'
  const tokens = rawQ
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  return {
    q: rawQ,
    tokens,
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    sortBy: rawSortBy || null,
    sortDir,
    hasPaginationParams: rawPage !== undefined || rawPageSize !== undefined || rawQ !== '' || rawSortBy !== '',
  }
}

export function resolveSqlPageWindow(
  total: number,
  requestedPage: number,
  pageSize: number,
): { safePage: number; safeOffset: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(Math.max(1, requestedPage), totalPages)
  return {
    safePage,
    safeOffset: (safePage - 1) * pageSize,
    totalPages,
  }
}

/**
 * Portable case-insensitive substring expression for VARCHAR/TEXT columns across
 * PostgreSQL, MySQL, MariaDB, and SQLite.
 */
export function sqlTextLike(columnRef: string, token: string): RawBuilder<boolean> {
  const pattern = `%${token.toLowerCase()}%`
  return sql<boolean>`lower(coalesce(${sql.ref(columnRef)}, '')) like ${pattern}`
}

export function compareSortableValues(
  a: string | number | boolean | null | undefined,
  b: string | number | boolean | null | undefined,
  direction: SortDirection,
): number {
  const aEmpty = a === null || a === undefined || a === ''
  const bEmpty = b === null || b === undefined || b === ''
  if (aEmpty && bEmpty) return 0
  if (aEmpty) return 1
  if (bEmpty) return -1

  let cmp = 0
  if (typeof a === 'number' && typeof b === 'number') {
    cmp = a - b
  } else if (typeof a === 'boolean' && typeof b === 'boolean') {
    cmp = a === b ? 0 : a ? -1 : 1
  } else {
    cmp = naturalCollator.compare(String(a), String(b))
  }
  return direction === 'asc' ? cmp : -cmp
}

export function paginateServerArray<T>(
  rows: T[],
  query: ParsedTableQuery,
  options: {
    getSearchText: (row: T) => string
    sortExtractors?: Record<string, (row: T) => string | number | boolean | null | undefined>
  },
): {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
} {
  const filtered =
    query.tokens.length === 0
      ? rows
      : rows.filter((row) => {
          const hay = options.getSearchText(row).toLowerCase()
          return query.tokens.every((tk) => hay.includes(tk))
        })

  const extractor =
    query.sortBy && options.sortExtractors ? options.sortExtractors[query.sortBy] : undefined

  const sorted = !extractor
    ? filtered
    : filtered
        .map((item, idx) => ({ item, idx }))
        .sort((l, r) => {
          const diff = compareSortableValues(extractor(l.item), extractor(r.item), query.sortDir)
          return diff !== 0 ? diff : l.idx - r.idx
        })
        .map((x) => x.item)

  const total = sorted.length
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize))
  const safePage = Math.min(query.page, totalPages)
  const start = (safePage - 1) * query.pageSize
  const items = sorted.slice(start, start + query.pageSize)

  return {
    items,
    total,
    page: safePage,
    pageSize: query.pageSize,
    totalPages,
  }
}
