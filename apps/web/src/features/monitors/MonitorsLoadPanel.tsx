'use client'

import {
  HTTP_METHODS,
  type HttpMethod,
  type LoadTestSummary,
} from '@meofast/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LayoutGroup, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  Dialog,
  DropdownMenu,
  Icon,
  Input,
  MethodBadge,
  renderMethodOption,
  renderMethodTrigger,
  Select,
  useConfirm,
  useToast,
} from '@/components/ui'
import { useWorkbenchStore } from '@/features/client/store/useWorkbenchStore'
import { apiRequest } from '@/lib/api-client'
import { cn, formatShortTime } from '@/utils/cn'

interface MonitorItem {
  id: string
  workspaceId: string
  name: string
  method: HttpMethod
  url: string
  expectedStatus: number
  maxLatencyMs: number
  intervalSeconds: number
  alertWebhookUrl: string
  enabled: boolean
  lastStatus: string
  lastLatencyMs: number | null
  ewmaLatencyMs?: number | null
  lastRunAt: string | null
  uptimePercent: number
  runs: Array<{
    id: string
    passed: boolean
    statusCode: number | null
    durationMs: number
    errorMessage: string | null
    checkedAt: string
  }>
}

export function MonitorsLoadPanel({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const { sidebarSubTab, setSidebarSection } = useWorkbenchStore()
  const subMode: 'loadtest' | 'monitors' = sidebarSubTab === 'monitors' ? 'monitors' : 'loadtest'
  const setSubMode = (nextMode: 'loadtest' | 'monitors') => {
    setSidebarSection('monitors', nextMode === 'monitors' ? 'monitors' : null)
  }

  // Load test state
  const [ltName, setLtName] = useState('Health & API Stress Run')
  const [ltMethod, setLtMethod] = useState<HttpMethod>('GET')
  const [ltUrl, setLtUrl] = useState('/api/v1/health')
  const [ltVus, setLtVus] = useState('5')
  const [ltTotalReqs, setLtTotalReqs] = useState('25')
  const [ltTargetRps, setLtTargetRps] = useState('0')
  const [selectedRunId, setSelectedRunId] = useState('')

  // Monitor modal state
  const [newMonOpen, setNewMonOpen] = useState(false)
  const [monName, setMonName] = useState('Core Health Monitor')
  const [monMethod, setMonMethod] = useState<HttpMethod>('GET')
  const [monUrl, setMonUrl] = useState('/api/v1/health')
  const [monExpected, setMonExpected] = useState('200')
  const [monMaxMs, setMonMaxMs] = useState('2000')
  const [monInterval, setMonInterval] = useState('300')
  const [monAlertUrl, setMonAlertUrl] = useState('')
  const [renameTarget, setRenameTarget] = useState<{
    kind: 'loadtest' | 'monitor'
    id: string
    name: string
  } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const loadRunsQuery = useQuery({
    queryKey: ['load-tests', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () =>
      apiRequest<{ runs: LoadTestSummary[] }>(`/api/v1/workspaces/${workspaceId}/load-tests`),
  })

  const monitorsQuery = useQuery({
    queryKey: ['monitors', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () =>
      apiRequest<{ monitors: MonitorItem[] }>(`/api/v1/workspaces/${workspaceId}/monitors`),
  })

  const loadRuns = loadRunsQuery.data?.runs ?? []
  const monitors = monitorsQuery.data?.monitors ?? []

  useEffect(() => {
    if (loadRuns.length > 0 && !loadRuns.some((r) => r.id === selectedRunId)) {
      setSelectedRunId(loadRuns[0]!.id)
    }
  }, [loadRuns, selectedRunId])

  const activeLoadRun = loadRuns.find((r) => r.id === selectedRunId) ?? loadRuns[0] ?? null

  const runLoadMutation = useMutation({
    mutationFn: async () => {
      return apiRequest<LoadTestSummary>(`/api/v1/workspaces/${workspaceId}/load-tests/run`, {
        method: 'POST',
        body: JSON.stringify({
          name: ltName.trim() || 'Load Test Run',
          method: ltMethod,
          url: ltUrl.trim(),
          virtualUsers: Math.min(50, Math.max(1, Number(ltVus) || 5)),
          totalRequests: Math.min(500, Math.max(1, Number(ltTotalReqs) || 25)),
          targetRps: Math.min(500, Math.max(0, Number(ltTargetRps) || 0)),
        }),
      })
    },
    onSuccess: async (res) => {
      setSelectedRunId(res.id)
      toast.success('Load test completed', `${res.requestsPerSecond} req/s · p95 ${res.latency.p95Ms} ms`)
      await queryClient.invalidateQueries({ queryKey: ['load-tests', workspaceId] })
    },
    onError: (err) => {
      toast.error('Load test failed', err instanceof Error ? err.message : undefined)
    },
  })

  const createMonitorMutation = useMutation({
    mutationFn: async () => {
      return apiRequest<{ id: string }>(`/api/v1/workspaces/${workspaceId}/monitors`, {
        method: 'POST',
        body: JSON.stringify({
          name: monName.trim(),
          method: monMethod,
          url: monUrl.trim(),
          expectedStatus: Number(monExpected) || 200,
          maxLatencyMs: Number(monMaxMs) || 2000,
          intervalSeconds: Number(monInterval) || 300,
          alertWebhookUrl: monAlertUrl.trim(),
          enabled: true,
        }),
      })
    },
    onSuccess: async () => {
      setNewMonOpen(false)
      toast.success('Monitor created')
      await queryClient.invalidateQueries({ queryKey: ['monitors', workspaceId] })
    },
    onError: (err) => {
      toast.error('Failed to create monitor', err instanceof Error ? err.message : undefined)
    },
  })

  const checkMonitorNowMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest(`/api/v1/monitors/${id}/run`, { method: 'POST', body: '{}' })
    },
    onSuccess: async () => {
      toast.info('Health check executed')
      await queryClient.invalidateQueries({ queryKey: ['monitors', workspaceId] })
    },
    onError: (err) => {
      toast.error('Check failed', err instanceof Error ? err.message : undefined)
    },
  })

  const deleteLoadRunMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest(`/api/v1/load-tests/${id}`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      setSelectedRunId('')
      toast.danger('Load test run deleted')
      await queryClient.invalidateQueries({ queryKey: ['load-tests', workspaceId] })
    },
  })

  const renameMutation = useMutation({
    mutationFn: async () => {
      if (!renameTarget || !renameDraft.trim()) return null
      const nextName = renameDraft.trim()
      const endpoint =
        renameTarget.kind === 'loadtest'
          ? `/api/v1/load-tests/${renameTarget.id}`
          : `/api/v1/monitors/${renameTarget.id}`
      await apiRequest(endpoint, {
        method: 'PATCH',
        body: JSON.stringify({ name: nextName }),
      })
      return { ...renameTarget, name: nextName }
    },
    onSuccess: async (updated) => {
      setRenameTarget(null)
      setRenameDraft('')
      toast.success(updated?.kind === 'loadtest' ? 'Load test run renamed' : 'Monitor renamed')
      if (updated?.kind === 'loadtest') {
        await queryClient.invalidateQueries({ queryKey: ['load-tests', workspaceId] })
      } else {
        await queryClient.invalidateQueries({ queryKey: ['monitors', workspaceId] })
      }
    },
    onError: (err) => {
      toast.error('Failed to rename', err instanceof Error ? err.message : undefined)
    },
  })

  const deleteMonitorMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest(`/api/v1/monitors/${id}`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      toast.danger('Monitor deleted')
      await queryClient.invalidateQueries({ queryKey: ['monitors', workspaceId] })
    },
  })

  const handleExportLoadReport = () => {
    if (!activeLoadRun) return
    const blob = new Blob([JSON.stringify(activeLoadRun, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `meofast-loadtest-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.info('Load test report exported')
  }

  return (
    <div className="flex-1 min-w-0 flex overflow-hidden">
      {/* Left Docked Sidebar */}
      <aside className="w-64 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col shrink-0 hidden md:flex">
        <div className="p-2.5 border-b border-[var(--color-border)] flex flex-col gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
            Performance & Uptime
          </span>
          <LayoutGroup id="meofast-perf-submode">
            <div className="grid grid-cols-2 gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--color-surface-secondary)]">
              {(
                [
                  { id: 'loadtest', label: 'Load Test' },
                  { id: 'monitors', label: 'Monitors' },
                ] as const
              ).map((modeItem) => {
                const modeActive = subMode === modeItem.id
                return (
                  <button
                    key={modeItem.id}
                    type="button"
                    onClick={() => setSubMode(modeItem.id)}
                    className={cn(
                      'relative h-7 rounded-[var(--radius-sm)] text-xs font-medium cursor-pointer transition-colors',
                      modeActive
                        ? 'text-[var(--color-primary)]'
                        : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]',
                    )}
                  >
                    {modeActive ? (
                      <motion.span
                        layoutId="perf-submode-pill"
                        transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.6 }}
                        className="absolute inset-0 rounded-[var(--radius-sm)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
                      />
                    ) : null}
                    <span className="relative z-10">{modeItem.label}</span>
                  </button>
                )
              })}
            </div>
          </LayoutGroup>
        </div>

        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
          {subMode === 'loadtest' ? (
            loadRuns.length === 0 ? (
              <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">
                No load test runs yet.
              </div>
            ) : (
              loadRuns.map((r) => (
                <div
                  key={r.id}
                  onClick={() => setSelectedRunId(r.id)}
                  className={cn(
                    'group p-2.5 pr-1.5 rounded-[var(--radius-md)] text-left flex flex-col gap-1 cursor-pointer border transition-colors',
                    activeLoadRun?.id === r.id
                      ? 'bg-[var(--color-primary-subtle)] border-[var(--color-primary)]'
                      : 'border-transparent hover:bg-[var(--color-surface-hover)]',
                  )}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <MethodBadge method={r.method} compact active={activeLoadRun?.id === r.id} />
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-[11px] font-mono tabular-nums text-[var(--color-primary)] font-semibold">
                        {r.requestsPerSecond} req/s
                      </span>
                      <DropdownMenu
                        ariaLabel={`Actions for ${r.name}`}
                        align="start"
                        widthClassName="w-48"
                        triggerClassName="w-6 h-6 p-0 justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                        trigger={() => <Icon name="dots-vertical" size={13} />}
                        items={[
                          {
                            id: 'rename',
                            label: 'Rename Run',
                            icon: 'edit',
                            onSelect: () => {
                              setRenameTarget({ kind: 'loadtest', id: r.id, name: r.name })
                              setRenameDraft(r.name)
                            },
                          },
                          {
                            id: 'delete',
                            label: 'Delete Run',
                            icon: 'trash',
                            variant: 'danger',
                            dividerBefore: true,
                            onSelect: () => {
                              void (async () => {
                                const ok = await confirm({
                                  title: 'Delete load test run?',
                                  description: `Remove load test run "${r.name}"?`,
                                  confirmLabel: 'Delete Run',
                                })
                                if (ok) deleteLoadRunMutation.mutate(r.id)
                              })()
                            },
                          },
                        ]}
                      />
                    </div>
                  </div>
                  <span className="text-xs font-medium truncate pr-1">{r.name}</span>
                  <span className="text-[10px] text-[var(--color-text-muted)] tabular-nums pr-1">
                    p95 {r.latency.p95Ms} ms · {formatShortTime(r.createdAt)}
                  </span>
                </div>
              ))
            )
          ) : (
            <div className="flex flex-col gap-1.5 p-1">
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Icon name="plus" size={13} />}
                onClick={() => setNewMonOpen(true)}
              >
                New Monitor
              </Button>
              {monitors.map((m) => (
                <div
                  key={m.id}
                  className="p-2.5 pr-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background)] flex flex-col gap-1 text-xs"
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="font-semibold truncate">{m.name}</span>
                    <div className="flex items-center gap-1 shrink-0">
                      <Badge
                        variant={
                          m.lastStatus === 'healthy'
                            ? 'success'
                            : m.lastStatus === 'degraded'
                              ? 'warning'
                              : m.lastStatus === 'failing'
                                ? 'danger'
                                : 'neutral'
                        }
                      >
                        {m.uptimePercent}%
                      </Badge>
                      <DropdownMenu
                        ariaLabel={`Actions for ${m.name}`}
                        align="start"
                        widthClassName="w-48"
                        triggerClassName="w-6 h-6 p-0 justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                        trigger={() => <Icon name="dots-vertical" size={13} />}
                        items={[
                          {
                            id: 'rename',
                            label: 'Rename Monitor',
                            icon: 'edit',
                            onSelect: () => {
                              setRenameTarget({ kind: 'monitor', id: m.id, name: m.name })
                              setRenameDraft(m.name)
                            },
                          },
                          {
                            id: 'check-now',
                            label: 'Run Health Check Now',
                            icon: 'play',
                            onSelect: () => checkMonitorNowMutation.mutate(m.id),
                          },
                          {
                            id: 'delete',
                            label: 'Delete Monitor',
                            icon: 'trash',
                            variant: 'danger',
                            dividerBefore: true,
                            onSelect: () => {
                              void (async () => {
                                const ok = await confirm({
                                  title: 'Delete monitor?',
                                  description: `This action cannot be undone. Monitor "${m.name}" and its run history will be permanently deleted.`,
                                  confirmLabel: 'Delete Monitor',
                                })
                                if (ok) deleteMonitorMutation.mutate(m.id)
                              })()
                            },
                          },
                        ]}
                      />
                    </div>
                  </div>
                  <span className="text-[11px] font-mono text-[var(--color-text-secondary)] truncate pr-1">
                    {m.url}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* Full-Width Right Workspace */}
      <main className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-5">
        {subMode === 'loadtest' ? (
          <div className="w-full flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h1 className="text-base font-semibold tracking-tight">Performance & Load Testing</h1>
                <p className="text-xs text-[var(--color-text-secondary)]">
                  Simulate concurrent virtual users and inspect throughput and latency percentiles.
                </p>
              </div>
              {activeLoadRun ? (
                <Button
                  size="sm"
                  variant="primary"
                  leftIcon={<Icon name="download" size={13} />}
                  onClick={handleExportLoadReport}
                >
                  Export JSON
                </Button>
              ) : null}
            </div>

            <Card className="flex flex-col gap-3.5">
              <div className="grid grid-cols-1 md:grid-cols-[1.1fr_110px_1.5fr_95px_105px_105px_auto] items-end gap-3">
                <Input
                  label="Run Name"
                  value={ltName}
                  onChange={(e) => setLtName(e.target.value)}
                />
                <Select
                  label="Method"
                  value={ltMethod}
                  onValueChange={(v) => setLtMethod(v as HttpMethod)}
                  options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
                  popoverWidth={76}
                  renderTrigger={(opt) => renderMethodTrigger(opt, ltMethod)}
                  renderOption={renderMethodOption}
                />
                <Input
                  label="Target URL"
                  mono
                  value={ltUrl}
                  onChange={(e) => setLtUrl(e.target.value)}
                  placeholder="https://example.com/api"
                />
                <Input
                  label="VUs"
                  mono
                  value={ltVus}
                  onChange={(e) => setLtVus(e.target.value)}
                />
                <Input
                  label="Requests"
                  mono
                  value={ltTotalReqs}
                  onChange={(e) => setLtTotalReqs(e.target.value)}
                />
                <Input
                  label="Target RPS"
                  mono
                  value={ltTargetRps}
                  onChange={(e) => setLtTargetRps(e.target.value)}
                  placeholder="0 = Max"
                />
                <Button
                  size="md"
                  variant="primary"
                  disabled={!ltUrl.trim()}
                  isLoading={runLoadMutation.isPending}
                  leftIcon={<Icon name="play" size={13} />}
                  onClick={() => runLoadMutation.mutate()}
                >
                  Run Test
                </Button>
              </div>
            </Card>

            {activeLoadRun ? (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 tabular-nums">
                  {[
                    { label: 'Throughput', value: `${activeLoadRun.requestsPerSecond} req/s` },
                    { label: 'Error Rate', value: `${activeLoadRun.errorRatePercent}%` },
                    { label: 'p50 Latency', value: `${activeLoadRun.latency.p50Ms} ms` },
                    { label: 'p95 Latency', value: `${activeLoadRun.latency.p95Ms} ms` },
                    { label: 'p99 Latency', value: `${activeLoadRun.latency.p99Ms} ms` },
                    {
                      label: 'Apdex / Jitter',
                      value:
                        activeLoadRun.apdexScore !== undefined
                          ? `${activeLoadRun.apdexScore.toFixed(2)} · ±${activeLoadRun.jitterMs ?? 0} ms`
                          : `${activeLoadRun.latency.avgMs} / ${activeLoadRun.latency.maxMs} ms`,
                    },
                  ].map((kpi) => (
                    <Card key={kpi.label} className="p-3.5 flex flex-col gap-1">
                      <span className="text-xs text-[var(--color-text-secondary)]">
                        {kpi.label}
                      </span>
                      <span className="text-base font-bold font-mono text-[var(--color-text)]">
                        {kpi.value}
                      </span>
                    </Card>
                  ))}
                </div>

                <Card className="p-5 flex flex-col gap-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="text-sm font-semibold">Latency Distribution</span>
                    <div className="flex items-center gap-2">
                      {Object.entries(activeLoadRun.statusCounts).map(([code, cnt]) => (
                        <Badge
                          key={code}
                          variant={code.startsWith('2') ? 'success' : 'danger'}
                        >
                          HTTP {code}: {cnt}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2.5 tabular-nums">
                    {activeLoadRun.buckets.map((bucket) => {
                      const pct = Math.round(
                        (bucket.count / Math.max(1, activeLoadRun.totalRequests)) * 100,
                      )
                      return (
                        <div key={bucket.label} className="grid grid-cols-[110px_1fr_64px] items-center gap-3 text-xs">
                          <span className="font-mono text-[var(--color-text-secondary)]">
                            {bucket.label}
                          </span>
                          <div className="h-3 rounded-full bg-[var(--color-surface-secondary)] overflow-hidden">
                            <div
                              style={{ width: `${Math.max(pct, bucket.count > 0 ? 4 : 0)}%` }}
                              className="h-full rounded-full bg-[var(--color-primary)]"
                            />
                          </div>
                          <span className="font-mono text-right">{bucket.count} req</span>
                        </div>
                      )
                    })}
                  </div>
                </Card>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="w-full flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h1 className="text-base font-semibold tracking-tight">Scheduled API Monitoring</h1>
                <p className="text-xs text-[var(--color-text-secondary)]">
                  Track endpoint availability, latency thresholds, and incident history.
                </p>
              </div>
              <Button
                size="sm"
                variant="primary"
                leftIcon={<Icon name="plus" size={13} />}
                onClick={() => setNewMonOpen(true)}
              >
                New Monitor
              </Button>
            </div>

            {monitors.length === 0 ? (
              <Card className="p-8 text-center text-sm text-[var(--color-text-muted)]">
                No scheduled monitors configured yet.
              </Card>
            ) : (
              <div className="flex flex-col gap-4">
                {monitors.map((m) => (
                  <Card key={m.id} className="p-5 flex flex-col gap-3.5">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2.5 flex-wrap">
                          <MethodBadge method={m.method} compact />
                          <span className="font-semibold text-sm">{m.name}</span>
                          <Badge
                            variant={
                              m.lastStatus === 'healthy'
                                ? 'success'
                                : m.lastStatus === 'degraded'
                                  ? 'warning'
                                  : m.lastStatus === 'failing'
                                    ? 'danger'
                                    : 'neutral'
                            }
                          >
                            {m.lastStatus.toUpperCase()}
                          </Badge>
                          <Badge variant="info">Uptime {m.uptimePercent}%</Badge>
                          {typeof m.ewmaLatencyMs === 'number' ? (
                            <Badge variant="neutral">Baseline {m.ewmaLatencyMs} ms</Badge>
                          ) : null}
                        </div>
                        <span className="text-xs font-mono text-[var(--color-text-secondary)]">
                          {m.url} · Every {Math.round(m.intervalSeconds / 60)}m · Expect{' '}
                          {m.expectedStatus} (&lt; {m.maxLatencyMs} ms)
                        </span>
                      </div>

                      <DropdownMenu
                        ariaLabel={`Actions for ${m.name}`}
                        widthClassName="w-48"
                        triggerClassName="w-[30px] h-[30px] justify-center border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
                        trigger={() => <Icon name="dots-vertical" size={14} />}
                        items={[
                          {
                            id: 'rename',
                            label: 'Rename Monitor',
                            icon: 'edit',
                            onSelect: () => {
                              setRenameTarget({ kind: 'monitor', id: m.id, name: m.name })
                              setRenameDraft(m.name)
                            },
                          },
                          {
                            id: 'check-now',
                            label: 'Run Health Check Now',
                            icon: 'play',
                            onSelect: () => checkMonitorNowMutation.mutate(m.id),
                          },
                          {
                            id: 'delete',
                            label: 'Delete Monitor',
                            icon: 'trash',
                            variant: 'danger',
                            dividerBefore: true,
                            onSelect: () => {
                              void (async () => {
                                const ok = await confirm({
                                  title: 'Delete monitor?',
                                  description: `This action cannot be undone. Monitor "${m.name}" and its run history will be permanently deleted.`,
                                  confirmLabel: 'Delete Monitor',
                                })
                                if (ok) deleteMonitorMutation.mutate(m.id)
                              })()
                            },
                          },
                        ]}
                      />
                    </div>

                    {/* Recent Check Bars */}
                    <div className="flex items-center gap-1.5 h-7">
                      {m.runs.length === 0 ? (
                        <span className="text-xs text-[var(--color-text-muted)]">
                          Click Check Now to run the first health probe.
                        </span>
                      ) : (
                        m.runs
                          .slice()
                          .reverse()
                          .map((run) => (
                            <div
                              key={run.id}
                              title={`${run.passed ? 'PASS' : 'FAIL'} · HTTP ${run.statusCode ?? 'ERR'} · ${run.durationMs} ms`}
                              className={cn(
                                'h-6 w-3 rounded-[3px] transition-opacity hover:opacity-80',
                                run.passed
                                  ? 'bg-[var(--color-success)]'
                                  : 'bg-[var(--color-danger)]',
                              )}
                            />
                          ))
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      <Dialog
        open={newMonOpen}
        title="New Scheduled Monitor"
        onClose={() => setNewMonOpen(false)}
      >
        <div className="flex flex-col gap-3.5">
          <Input
            label="Monitor Name"
            value={monName}
            onChange={(e) => setMonName(e.target.value)}
            required
          />
          <div className="grid grid-cols-[120px_1fr] gap-3">
            <Select
              label="Method"
              value={monMethod}
              onValueChange={(v) => setMonMethod(v as HttpMethod)}
              options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
              popoverWidth={76}
              renderTrigger={(opt) => renderMethodTrigger(opt, monMethod)}
              renderOption={renderMethodOption}
            />
            <Input
              label="Endpoint URL"
              mono
              value={monUrl}
              onChange={(e) => setMonUrl(e.target.value)}
              required
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Input
              label="Expected Status"
              mono
              value={monExpected}
              onChange={(e) => setMonExpected(e.target.value)}
            />
            <Input
              label="Max Latency (ms)"
              mono
              value={monMaxMs}
              onChange={(e) => setMonMaxMs(e.target.value)}
            />
            <Select
              label="Schedule"
              value={monInterval}
              onValueChange={setMonInterval}
              options={[
                { value: '60', label: 'Every 1 min' },
                { value: '300', label: 'Every 5 min' },
                { value: '900', label: 'Every 15 min' },
                { value: '3600', label: 'Every 1 hour' },
              ]}
            />
          </div>
          <Input
            label="Alert Webhook URL (Optional)"
            mono
            value={monAlertUrl}
            onChange={(e) => setMonAlertUrl(e.target.value)}
            placeholder="/api/v1/webhooks/in/..."
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setNewMonOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!monName.trim() || !monUrl.trim()}
              isLoading={createMonitorMutation.isPending}
              onClick={() => createMonitorMutation.mutate()}
            >
              Create Monitor
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(renameTarget)}
        title={renameTarget?.kind === 'loadtest' ? 'Rename Load Test Run' : 'Rename Monitor'}
        onClose={() => setRenameTarget(null)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label={renameTarget?.kind === 'loadtest' ? 'Run Name' : 'Monitor Name'}
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renameDraft.trim() && !renameMutation.isPending) {
                e.preventDefault()
                renameMutation.mutate()
              }
            }}
            required
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!renameDraft.trim()}
              isLoading={renameMutation.isPending}
              onClick={() => renameMutation.mutate()}
            >
              Save Name
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
