'use client'

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { apiRequest } from '@/lib/api-client'
import { cn } from '@/utils/cn'

export type SortDirection = 'asc' | 'desc'

export interface DataTableColumn<T> {
  id: string
  header: ReactNode
  cell: (row: T, rowIndex: number) => ReactNode
  accessorKey?: keyof T
  sortValue?: (row: T) => string | number | boolean | null | undefined
  searchValue?: (row: T) => string | number | null | undefined
  sortable?: boolean
  align?: 'left' | 'center' | 'right'
  headerClassName?: string
  cellClassName?: string
}

export interface DataTableServerConfig {
  /** Base TanStack Query key (prefix-matched by invalidateQueries) */
  queryKey: readonly unknown[]
  /** Server GET endpoint accepting ?q=&page=&pageSize=&sortBy=&sortDir= */
  endpoint: string
  /** Extra query string parameters (e.g. scope, kind, leftId, rightId) */
  params?: Record<string, string | number | boolean | undefined | null>
  /** Disable query when prerequisite IDs are empty */
  enabled?: boolean
}

interface ServerPaginatedPayload<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface DataTableProps<T> {
  /** Optional client-side rows (used when `server` is not provided) */
  data?: T[]
  /** Server-side search, sort, row size & pagination configuration */
  server?: DataTableServerConfig
  columns: DataTableColumn<T>[]
  getRowKey: (row: T, index: number) => string
  searchPlaceholder?: string
  searchQuery?: string
  onSearchQueryChange?: (next: string) => void
  searchable?: boolean
  toolbarLeft?: ReactNode
  toolbarRight?: ReactNode
  defaultPageSize?: number
  pageSizeOptions?: number[]
  initialSort?: { columnId: string; direction: SortDirection } | null
  emptyMessage?: ReactNode
  noResultsMessage?: string
  loading?: boolean
  compact?: boolean
  maxBodyHeightClassName?: string
  rowClassName?: string | ((row: T, index: number) => string | undefined)
  className?: string
}

const DEFAULT_PAGE_SIZES = [5, 10, 25, 50, 100]

const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

function extractPrimitiveValue<T>(
  row: T,
  col: DataTableColumn<T>,
): string | number | boolean | null | undefined {
  if (col.sortValue) return col.sortValue(row)
  if (col.accessorKey !== undefined && row && typeof row === 'object') {
    const raw = (row as Record<string, unknown>)[String(col.accessorKey)]
    if (
      typeof raw === 'string' ||
      typeof raw === 'number' ||
      typeof raw === 'boolean' ||
      raw === null ||
      raw === undefined
    ) {
      return raw
    }
  }
  return undefined
}

function buildRowSearchHaystack<T>(row: T, columns: DataTableColumn<T>[]): string {
  const parts: string[] = []
  for (const col of columns) {
    if (col.searchValue) {
      const sv = col.searchValue(row)
      if (sv !== null && sv !== undefined && sv !== '') parts.push(String(sv))
      continue
    }
    const pv = extractPrimitiveValue(row, col)
    if (pv !== null && pv !== undefined && pv !== '') {
      parts.push(String(pv))
    }
  }

  if (row && typeof row === 'object') {
    for (const val of Object.values(row as Record<string, unknown>)) {
      if (typeof val === 'string' || typeof val === 'number') {
        parts.push(String(val))
      }
    }
  }

  return parts.join(' ').toLowerCase()
}

function compareValues(
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

function buildVisiblePages(currentPage: number, totalPages: number): Array<number | 'ellipsis'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }
  const pages: Array<number | 'ellipsis'> = [1]
  const start = Math.max(2, currentPage - 1)
  const end = Math.min(totalPages - 1, currentPage + 1)

  if (start > 2) pages.push('ellipsis')
  for (let p = start; p <= end; p += 1) {
    pages.push(p)
  }
  if (end < totalPages - 1) pages.push('ellipsis')
  pages.push(totalPages)
  return pages
}

export function DataTable<T>({
  data = [],
  server,
  columns,
  getRowKey,
  searchPlaceholder = 'Search...',
  searchQuery: controlledSearch,
  onSearchQueryChange,
  searchable = true,
  toolbarLeft,
  toolbarRight,
  defaultPageSize = 10,
  pageSizeOptions = DEFAULT_PAGE_SIZES,
  initialSort = null,
  emptyMessage = 'No records available.',
  noResultsMessage,
  loading = false,
  compact = false,
  maxBodyHeightClassName,
  rowClassName,
  className,
}: DataTableProps<T>) {
  const [internalSearch, setInternalSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [sortState, setSortState] = useState<{
    columnId: string
    direction: SortDirection
  } | null>(initialSort)
  const [pageSize, setPageSize] = useState<number>(() =>
    pageSizeOptions.includes(defaultPageSize) ? defaultPageSize : (pageSizeOptions[0] ?? 10),
  )
  const [page, setPage] = useState(1)

  const searchText = controlledSearch !== undefined ? controlledSearch : internalSearch

  useEffect(() => {
    const trimmed = searchText.trim()
    if (!trimmed) {
      setDebouncedSearch('')
      return
    }
    const timer = window.setTimeout(() => {
      setDebouncedSearch(trimmed)
    }, 200)
    return () => window.clearTimeout(timer)
  }, [searchText])

  const serverParamsKey = server ? `${server.endpoint}::${JSON.stringify(server.params ?? null)}` : ''
  const [lastServerContextKey, setLastServerContextKey] = useState(serverParamsKey)
  if (server && serverParamsKey !== lastServerContextKey) {
    setLastServerContextKey(serverParamsKey)
    setPage(1)
  }

  const handleSearchChange = (next: string) => {
    if (controlledSearch === undefined) {
      setInternalSearch(next)
    }
    onSearchQueryChange?.(next)
    setPage(1)
  }

  // Pure numeric labels ("5", "10", "25", "50", "100") — never "/ page"
  const resolvedSizeOptions = useMemo(() => {
    const unique = Array.from(new Set([...pageSizeOptions, pageSize])).sort((a, b) => a - b)
    return unique.map((sz) => ({ value: String(sz), label: String(sz) }))
  }, [pageSizeOptions, pageSize])

  const serverQuery = useQuery({
    queryKey: server
      ? [
          ...server.queryKey,
          'data-table',
          server.endpoint,
          server.params ?? null,
          {
            q: debouncedSearch,
            page,
            pageSize,
            sortBy: sortState?.columnId ?? null,
            sortDir: sortState?.direction ?? null,
          },
        ]
      : ['__client-data-table__'],
    enabled: Boolean(server) && (server?.enabled ?? true),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      if (!server) return { items: [] as T[], total: 0, page: 1, pageSize }
      const qs = new URLSearchParams()
      if (server.params) {
        for (const [k, v] of Object.entries(server.params)) {
          if (v !== undefined && v !== null && v !== '') {
            qs.set(k, String(v))
          }
        }
      }
      qs.set('page', String(page))
      qs.set('pageSize', String(pageSize))
      if (debouncedSearch) {
        qs.set('q', debouncedSearch)
      }
      if (sortState) {
        qs.set('sortBy', sortState.columnId)
        qs.set('sortDir', sortState.direction)
      }
      const sep = server.endpoint.includes('?') ? '&' : '?'
      return apiRequest<ServerPaginatedPayload<T>>(`${server.endpoint}${sep}${qs.toString()}`)
    },
  })

  // Client-side fallback pipeline (used only when `server` is omitted)
  const clientFilteredRows = useMemo(() => {
    if (server) return []
    const q = searchText.trim().toLowerCase()
    if (!q) return data
    const tokens = q.split(/\s+/).filter(Boolean)
    return data.filter((row) => {
      const haystack = buildRowSearchHaystack(row, columns)
      return tokens.every((tk) => haystack.includes(tk))
    })
  }, [server, data, columns, searchText])

  const clientSortedRows = useMemo(() => {
    if (server) return []
    if (!sortState) return clientFilteredRows
    const col = columns.find((c) => c.id === sortState.columnId)
    if (!col || col.sortable === false) return clientFilteredRows

    return clientFilteredRows
      .map((item, idx) => ({ item, idx }))
      .sort((left, right) => {
        const av = extractPrimitiveValue(left.item, col)
        const bv = extractPrimitiveValue(right.item, col)
        const diff = compareValues(av, bv, sortState.direction)
        return diff !== 0 ? diff : left.idx - right.idx
      })
      .map((entry) => entry.item)
  }, [server, clientFilteredRows, columns, sortState])

  const totalCount = server ? (serverQuery.data?.total ?? 0) : clientSortedRows.length
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const safePage = server
    ? Math.min(serverQuery.data?.page ?? page, totalPages)
    : Math.min(page, totalPages)
  const startIndex = (safePage - 1) * pageSize

  const pagedRows = useMemo(() => {
    if (server) return serverQuery.data?.items ?? []
    return clientSortedRows.slice(startIndex, startIndex + pageSize)
  }, [server, serverQuery.data?.items, clientSortedRows, startIndex, pageSize])

  const handleToggleSort = (col: DataTableColumn<T>) => {
    if (col.sortable === false) return
    setSortState((prev) => {
      if (!prev || prev.columnId !== col.id) {
        return { columnId: col.id, direction: 'asc' }
      }
      if (prev.direction === 'asc') {
        return { columnId: col.id, direction: 'desc' }
      }
      return null
    })
    setPage(1)
  }

  const visiblePages = useMemo(
    () => buildVisiblePages(safePage, totalPages),
    [safePage, totalPages],
  )

  const showToolbar = Boolean(searchable || toolbarLeft || toolbarRight)
  const isInitialServerLoading = Boolean(loading || (server && serverQuery.isLoading && !serverQuery.data))
  const hasActiveSearch = Boolean((server ? debouncedSearch : searchText).trim())

  return (
    <div
      className={cn(
        'w-full flex flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden',
        className,
      )}
    >
      {showToolbar ? (
        <div
          className={cn(
            'flex items-center justify-between gap-2.5 flex-wrap border-b border-[var(--color-border)] bg-[var(--color-surface)]',
            compact ? 'px-2.5 py-2' : 'px-3.5 py-2.5',
          )}
        >
          <div className="flex items-center gap-2.5 flex-wrap min-w-0 flex-1">
            {toolbarLeft}
            {searchable ? (
              <div className={cn('relative w-full', compact ? 'sm:w-52' : 'sm:w-64')}>
                <Input
                  size="sm"
                  type="search"
                  leftIcon={<Icon name="search" size={13} />}
                  value={searchText}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                />
              </div>
            ) : null}
          </div>

          {toolbarRight ? (
            <div className="flex items-center gap-2 flex-wrap shrink-0">{toolbarRight}</div>
          ) : null}
        </div>
      ) : null}

      <div
        className={cn(
          'w-full overflow-x-auto',
          maxBodyHeightClassName && 'overflow-y-auto',
          maxBodyHeightClassName,
        )}
      >
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr
              className={cn(
                'bg-[var(--color-surface-secondary)] border-b border-[var(--color-border)]',
                compact ? 'h-8' : 'h-9',
                maxBodyHeightClassName && 'sticky top-0 z-10',
              )}
            >
              {columns.map((col) => {
                const isSortable = col.sortable !== false
                const activeDir = sortState?.columnId === col.id ? sortState.direction : null
                const ariaSort = !isSortable
                  ? undefined
                  : activeDir === 'asc'
                    ? 'ascending'
                    : activeDir === 'desc'
                      ? 'descending'
                      : 'none'

                return (
                  <th
                    key={col.id}
                    scope="col"
                    aria-sort={ariaSort}
                    className={cn(
                      'font-semibold text-[var(--color-text-secondary)] select-none whitespace-nowrap',
                      compact ? 'py-1.5 px-3' : 'py-2 px-3.5',
                      col.align === 'right' && 'text-right',
                      col.align === 'center' && 'text-center',
                      col.headerClassName,
                    )}
                  >
                    {isSortable ? (
                      <button
                        type="button"
                        onClick={() => handleToggleSort(col)}
                        className={cn(
                          'group inline-flex items-center gap-1.5 font-semibold cursor-pointer rounded-[var(--radius-sm)] transition-colors hover:text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]',
                          activeDir && 'text-[var(--color-primary)] hover:text-[var(--color-primary)]',
                          col.align === 'right' && 'ml-auto flex-row-reverse',
                          col.align === 'center' && 'mx-auto',
                        )}
                      >
                        <span>{col.header}</span>
                        <Icon
                          name={
                            activeDir === 'asc'
                              ? 'arrow-up'
                              : activeDir === 'desc'
                                ? 'arrow-down'
                                : 'chevrons-up-down'
                          }
                          size={12}
                          className={cn(
                            'shrink-0 transition-opacity',
                            activeDir
                              ? 'text-[var(--color-primary)] opacity-100'
                              : 'text-[var(--color-text-muted)] opacity-55 group-hover:opacity-100',
                          )}
                        />
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>

          <tbody className="divide-y divide-[var(--color-border)]">
            {isInitialServerLoading ? (
              Array.from({ length: Math.min(Math.max(pageSize, 3), 6) }).map((_, rIdx) => (
                <tr
                  key={`skeleton-row-${rIdx}`}
                  className="border-b border-[var(--color-border)] animate-pulse"
                >
                  {columns.map((col, cIdx) => {
                    const widthClass =
                      cIdx === 0
                        ? 'w-3/4'
                        : cIdx === columns.length - 1
                          ? 'w-16 ml-auto'
                          : (rIdx + cIdx) % 3 === 0
                            ? 'w-1/2'
                            : (rIdx + cIdx) % 3 === 1
                              ? 'w-2/3'
                              : 'w-1/3'
                    return (
                      <td
                        key={col.id}
                        className={cn(
                          compact ? 'py-2 px-3' : 'py-3 px-3.5',
                          col.align === 'right' && 'text-right',
                          col.align === 'center' && 'text-center',
                          col.cellClassName,
                        )}
                      >
                        <div
                          className={cn(
                            'h-4 rounded-[var(--radius-sm)] bg-[var(--color-surface-secondary)]',
                            widthClass,
                            col.align === 'center' && 'mx-auto',
                          )}
                        />
                      </td>
                    )
                  })}
                </tr>
              ))
            ) : pagedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={Math.max(1, columns.length)}
                  className={cn(
                    'text-center text-[var(--color-text-muted)]',
                    compact ? 'py-5 px-3' : 'py-7 px-3.5',
                  )}
                >
                  {!hasActiveSearch
                    ? emptyMessage
                    : (noResultsMessage ?? `No matching records for "${searchText.trim()}".`)}
                </td>
              </tr>
            ) : (
              pagedRows.map((row, idx) => {
                const absoluteIdx = startIndex + idx
                const customRowCls =
                  typeof rowClassName === 'function' ? rowClassName(row, absoluteIdx) : rowClassName
                return (
                  <tr
                    key={getRowKey(row, absoluteIdx)}
                    className={cn(
                      'hover:bg-[var(--color-surface-hover)]/60 transition-colors',
                      customRowCls,
                    )}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.id}
                        className={cn(
                          compact ? 'py-2 px-3' : 'py-2.5 px-3.5',
                          col.align === 'right' && 'text-right',
                          col.align === 'center' && 'text-center',
                          col.cellClassName,
                        )}
                      >
                        {col.cell(row, absoluteIdx)}
                      </td>
                    ))}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination & Pure-Number Row Size Footer */}
      <div
        className={cn(
          'flex items-center justify-between gap-3 flex-wrap border-t border-[var(--color-border)] bg-[var(--color-surface-secondary)]/55 text-xs tabular-nums',
          compact ? 'px-2.5 py-1.5' : 'px-3.5 py-2',
        )}
      >
        <div className="flex items-center gap-2.5 flex-wrap text-[var(--color-text-secondary)]">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-[var(--color-text-muted)]">Rows:</span>
            <Select
              size="sm"
              ariaLabel="Rows per page"
              value={String(pageSize)}
              onValueChange={(val) => {
                const parsed = Number(val)
                if (parsed > 0) {
                  setPageSize(parsed)
                  setPage(1)
                }
              }}
              options={resolvedSizeOptions}
              className="w-[68px]"
              triggerClassName="tabular-nums"
            />
          </div>

          <span className="text-[11px] text-[var(--color-text-secondary)]">
            {totalCount === 0
              ? '0 rows'
              : `Showing ${startIndex + 1}–${Math.min(startIndex + pagedRows.length, totalCount)} of ${totalCount}`}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={safePage <= 1}
            aria-label="Previous page"
            onClick={() => setPage(Math.max(1, safePage - 1))}
            className="w-7 h-7 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] inline-flex items-center justify-center text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] disabled:opacity-40 disabled:pointer-events-none cursor-pointer transition-colors"
          >
            <Icon name="chevron-left" size={13} />
          </button>

          {visiblePages.map((p, idx) =>
            p === 'ellipsis' ? (
              <span
                key={`ellipsis-${idx}`}
                className="w-6 h-7 inline-flex items-center justify-center text-[11px] text-[var(--color-text-muted)] select-none"
              >
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                aria-label={`Page ${p}`}
                aria-current={p === safePage ? 'page' : undefined}
                onClick={() => setPage(p)}
                className={cn(
                  'min-w-[28px] h-7 px-1.5 rounded-[var(--radius-sm)] text-xs font-medium inline-flex items-center justify-center cursor-pointer transition-colors',
                  p === safePage
                    ? 'bg-[var(--color-primary)] text-white font-semibold shadow-[var(--shadow-xs)]'
                    : 'border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]',
                )}
              >
                {p}
              </button>
            ),
          )}

          <button
            type="button"
            disabled={safePage >= totalPages}
            aria-label="Next page"
            onClick={() => setPage(Math.min(totalPages, safePage + 1))}
            className="w-7 h-7 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] inline-flex items-center justify-center text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] disabled:opacity-40 disabled:pointer-events-none cursor-pointer transition-colors"
          >
            <Icon name="chevron-right" size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
