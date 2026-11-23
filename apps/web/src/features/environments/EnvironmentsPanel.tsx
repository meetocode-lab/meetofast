'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  DropdownMenu,
  Icon,
  Input,
  Select,
  useConfirm,
  useToast,
} from '@/components/ui'
import { apiRequest } from '@/lib/api-client'
import { cn } from '@/utils/cn'

interface EnvVarItem {
  id?: string
  key: string
  value: string
  isSecret: boolean
  hasSecretValue?: boolean
  keepExistingSecret?: boolean
  enabled: boolean
}

interface EnvironmentRecord {
  id: string
  workspaceId: string
  name: string
  isGlobal: boolean
  variables: EnvVarItem[]
}

export function EnvironmentsPanel({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [selectedEnvId, setSelectedEnvId] = useState<string>('')
  const [envFilter, setEnvFilter] = useState('')
  const [editName, setEditName] = useState('')
  const [editVars, setEditVars] = useState<EnvVarItem[]>([])
  const [isDirty, setIsDirty] = useState(false)

  // Modals
  const [createOpen, setCreateOpen] = useState(false)
  const [newEnvName, setNewEnvName] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [dotenvName, setDotenvName] = useState('')
  const [dotenvContent, setDotenvContent] = useState('')
  const [compareOpen, setCompareOpen] = useState(false)
  const [compareLeftId, setCompareLeftId] = useState('')
  const [compareRightId, setCompareRightId] = useState('')
  const [renameEnvTarget, setRenameEnvTarget] = useState<{ id: string; name: string } | null>(null)
  const [renameEnvDraft, setRenameEnvDraft] = useState('')

  const envsQuery = useQuery({
    queryKey: ['environments', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () =>
      apiRequest<{ environments: EnvironmentRecord[] }>(
        `/api/v1/workspaces/${workspaceId}/environments`,
      ),
  })

  const environments = envsQuery.data?.environments ?? []

  useEffect(() => {
    if (environments.length > 0 && !environments.some((e) => e.id === selectedEnvId)) {
      const first = environments[0]!
      setSelectedEnvId(first.id)
      setEditName(first.name)
      setEditVars(
        first.variables.map((v) => ({
          ...v,
          keepExistingSecret: Boolean(v.hasSecretValue),
        })),
      )
      setIsDirty(false)
    }
  }, [environments, selectedEnvId])

  const selectEnvironment = async (env: EnvironmentRecord) => {
    if (env.id === selectedEnvId) return
    if (isDirty) {
      const ok = await confirm({
        title: 'Discard unsaved variables?',
        description: `Environment "${editName}" has unsaved changes. Switching now will discard your edits.`,
        confirmLabel: 'Discard Changes',
        variant: 'warning',
      })
      if (!ok) return
    }
    setSelectedEnvId(env.id)
    setEditName(env.name)
    setEditVars(
      env.variables.map((v) => ({
        ...v,
        keepExistingSecret: Boolean(v.hasSecretValue),
      })),
    )
    setIsDirty(false)
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const current = environments.find((e) => e.id === selectedEnvId)
      if (!current) return
      await apiRequest(`/api/v1/environments/${current.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editName,
          isGlobal: current.isGlobal,
          variables: editVars
            .filter((v) => v.key.trim().length > 0)
            .map((v) => ({
              id: v.id,
              key: v.key.trim(),
              value: v.value,
              isSecret: v.isSecret,
              enabled: v.enabled,
              keepExistingSecret: v.isSecret && !v.value && Boolean(v.keepExistingSecret),
            })),
        }),
      })
    },
    onSuccess: async () => {
      setIsDirty(false)
      toast.success('Variables saved', 'Encrypted secrets and plain variables updated.')
      await queryClient.invalidateQueries({ queryKey: ['environments', workspaceId] })
    },
    onError: (err) => {
      toast.error('Failed to save variables', err instanceof Error ? err.message : undefined)
    },
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      return apiRequest<{ id: string }>(`/api/v1/workspaces/${workspaceId}/environments`, {
        method: 'POST',
        body: JSON.stringify({
          name: newEnvName.trim(),
          isGlobal: false,
          variables: [],
        }),
      })
    },
    onSuccess: async (res) => {
      setCreateOpen(false)
      setNewEnvName('')
      setIsDirty(false)
      toast.success('Environment created')
      await queryClient.invalidateQueries({ queryKey: ['environments', workspaceId] })
      setSelectedEnvId(res.id)
    },
    onError: (err) => {
      toast.error('Failed to create environment', err instanceof Error ? err.message : undefined)
    },
  })

  const renameEnvMutation = useMutation({
    mutationFn: async () => {
      if (!renameEnvTarget || !renameEnvDraft.trim()) return null
      const nextName = renameEnvDraft.trim()
      await apiRequest(`/api/v1/environments/${renameEnvTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: nextName }),
      })
      return { id: renameEnvTarget.id, name: nextName }
    },
    onSuccess: async (updated) => {
      if (updated && updated.id === selectedEnvId) {
        setEditName(updated.name)
      }
      setRenameEnvTarget(null)
      setRenameEnvDraft('')
      toast.success('Environment renamed')
      await queryClient.invalidateQueries({ queryKey: ['environments', workspaceId] })
    },
    onError: (err) => {
      toast.error('Failed to rename environment', err instanceof Error ? err.message : undefined)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (envId: string) => {
      await apiRequest(`/api/v1/environments/${envId}`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      setSelectedEnvId('')
      setIsDirty(false)
      toast.danger('Environment deleted')
      await queryClient.invalidateQueries({ queryKey: ['environments', workspaceId] })
    },
    onError: (err) => {
      toast.error('Failed to delete environment', err instanceof Error ? err.message : undefined)
    },
  })

  const importDotenvMutation = useMutation({
    mutationFn: async () => {
      return apiRequest<{ id: string }>(
        `/api/v1/workspaces/${workspaceId}/environments/import-dotenv`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: dotenvName.trim(),
            dotenvContent,
          }),
        },
      )
    },
    onSuccess: async (res) => {
      setImportOpen(false)
      setDotenvName('')
      setDotenvContent('')
      setIsDirty(false)
      toast.success('.env imported', 'Variables created cleanly.')
      await queryClient.invalidateQueries({ queryKey: ['environments', workspaceId] })
      setSelectedEnvId(res.id)
    },
    onError: (err) => {
      toast.error('Failed to import .env', err instanceof Error ? err.message : undefined)
    },
  })

  const handleExportDotenv = async () => {
    if (!selectedEnvId) return
    const res = await apiRequest<{ dotenv: string }>(
      `/api/v1/environments/${selectedEnvId}/export-dotenv`,
    )
    const blob = new Blob([res.dotenv], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${editName.toLowerCase().replace(/\s+/g, '-')}.env`
    a.click()
    URL.revokeObjectURL(url)
    toast.info('.env exported')
  }

  const activeEnv = environments.find((e) => e.id === selectedEnvId)
  const filteredEnvs = environments.filter(
    (e) => !envFilter.trim() || e.name.toLowerCase().includes(envFilter.toLowerCase()),
  )

  return (
    <div className="flex-1 min-w-0 w-full flex overflow-hidden">
      {/* Docked Left Sidebar Panel (w-64) — Consistent with Collections & History */}
      <aside className="w-64 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col shrink-0 hidden md:flex">
        <div className="p-2.5 border-b border-[var(--color-border)] flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold tracking-wide text-[var(--color-text-secondary)] uppercase">
              Environments
            </span>
            <DropdownMenu
              ariaLabel="Environments sidebar menu"
              align="start"
              widthClassName="w-52"
              triggerClassName="w-7 h-7 justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)]"
              trigger={() => <Icon name="dots-vertical" size={14} />}
              items={[
                {
                  id: 'new-env',
                  label: 'New Environment',
                  icon: 'plus',
                  onSelect: () => setCreateOpen(true),
                },
                {
                  id: 'import-env',
                  label: 'Import .env File',
                  icon: 'upload',
                  onSelect: () => setImportOpen(true),
                },
                ...(environments.length >= 2
                  ? [
                      {
                        id: 'compare-env',
                        label: 'Compare Environments',
                        icon: 'diff' as const,
                        onSelect: () => {
                          setCompareLeftId(environments[0]?.id ?? '')
                          setCompareRightId(environments[1]?.id ?? environments[0]?.id ?? '')
                          setCompareOpen(true)
                        },
                      },
                    ]
                  : []),
              ]}
            />
          </div>

          <Input
            size="sm"
            type="search"
            leftIcon={<Icon name="search" size={13} />}
            value={envFilter}
            onChange={(e) => setEnvFilter(e.target.value)}
            placeholder="Filter environments..."
            aria-label="Filter environments"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2.5 flex flex-col gap-1">
          {filteredEnvs.map((env) => {
            const active = env.id === selectedEnvId
            return (
              <div
                key={env.id}
                onClick={() => {
                  void selectEnvironment(env)
                }}
                className={cn(
                  'group w-full h-9 pl-3 pr-1.5 rounded-[var(--radius-md)] text-left text-xs font-medium flex items-center justify-between gap-2 cursor-pointer transition-colors',
                  active
                    ? 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)] font-semibold'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]',
                )}
              >
                <span className="inline-flex items-center gap-2 min-w-0 truncate">
                  <Icon
                    name={env.isGlobal ? 'globe' : 'layers'}
                    size={14}
                    className={active ? 'text-[var(--color-primary)] shrink-0' : 'shrink-0'}
                  />
                  <span className="truncate">{env.name}</span>
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  {env.isGlobal ? (
                    <Badge variant="primary">Global</Badge>
                  ) : (
                    <Badge variant="neutral">{env.variables.length}</Badge>
                  )}
                  <DropdownMenu
                    ariaLabel={`Actions for ${env.name}`}
                    align="start"
                    widthClassName="w-48"
                    triggerClassName="w-6 h-6 p-0 justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                    trigger={() => <Icon name="dots-vertical" size={13} />}
                    items={[
                      {
                        id: 'rename',
                        label: 'Rename Environment',
                        icon: 'edit',
                        onSelect: () => {
                          setRenameEnvTarget({ id: env.id, name: env.name })
                          setRenameEnvDraft(env.name)
                        },
                      },
                      ...(!env.isGlobal
                        ? [
                            {
                              id: 'delete',
                              label: 'Delete Environment',
                              icon: 'trash' as const,
                              variant: 'danger' as const,
                              dividerBefore: true,
                              onSelect: () => {
                                void (async () => {
                                  const ok = await confirm({
                                    title: 'Delete environment?',
                                    description: `This action cannot be undone. Environment "${env.name}" and its variables will be permanently deleted.`,
                                    confirmLabel: 'Delete Environment',
                                  })
                                  if (ok) deleteMutation.mutate(env.id)
                                })()
                              },
                            },
                          ]
                        : []),
                    ]}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </aside>

      {/* Full-Width Right Workspace Surface */}
      <main className="flex-1 min-w-0 w-full overflow-y-auto p-4 sm:p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-base font-semibold">Environments</h1>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              Use <code className="font-mono">{'{{variable}}'}</code> in URLs, headers, auth, or
              request bodies.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="primary"
              leftIcon={<Icon name="plus" size={13} />}
              onClick={() => setCreateOpen(true)}
            >
              New Environment
            </Button>
            {environments.length >= 2 ? (
              <DropdownMenu
                ariaLabel="Environment actions"
                widthClassName="w-52"
                triggerClassName="w-[30px] h-[30px] justify-center border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
                trigger={() => <Icon name="dots-vertical" size={14} />}
                items={[
                  {
                    id: 'import',
                    label: 'Import .env File',
                    icon: 'upload',
                    onSelect: () => setImportOpen(true),
                  },
                  {
                    id: 'compare',
                    label: 'Compare Environments',
                    icon: 'diff',
                    onSelect: () => {
                      setCompareLeftId(environments[0]?.id ?? '')
                      setCompareRightId(environments[1]?.id ?? environments[0]?.id ?? '')
                      setCompareOpen(true)
                    },
                  },
                ]}
              />
            ) : (
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Icon name="upload" size={13} />}
                onClick={() => setImportOpen(true)}
              >
                Import .env
              </Button>
            )}
          </div>
        </div>

        {activeEnv ? (
          <Card padding="md" className="w-full flex flex-col gap-4">
            <div className="flex items-end justify-between gap-3 flex-wrap pb-3.5 border-b border-[var(--color-border)]">
              <div className="flex-1 min-w-[220px]">
                  <Input
                    label="Environment Name"
                    value={editName}
                    disabled={activeEnv.isGlobal}
                    onChange={(e) => {
                      setEditName(e.target.value)
                      setIsDirty(true)
                    }}
                  />
                </div>

                <div className="flex items-center gap-1.5">
                  {activeEnv.isGlobal ? (
                    <Button
                      size="md"
                      variant="secondary"
                      leftIcon={<Icon name="download" size={14} />}
                      onClick={() => {
                        void handleExportDotenv()
                      }}
                    >
                      Export .env
                    </Button>
                  ) : null}

                  <Button
                    size="md"
                    variant="primary"
                    isLoading={saveMutation.isPending}
                    leftIcon={<Icon name="save" size={14} />}
                    onClick={() => saveMutation.mutate()}
                  >
                    Save Variables
                  </Button>

                  {!activeEnv.isGlobal ? (
                    <DropdownMenu
                      ariaLabel="Active environment actions"
                      widthClassName="w-52"
                      triggerClassName="w-[34px] h-[34px] justify-center border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
                      trigger={() => <Icon name="dots-vertical" size={15} />}
                      items={[
                        {
                          id: 'export',
                          label: 'Export .env File',
                          icon: 'download',
                          onSelect: () => {
                            void handleExportDotenv()
                          },
                        },
                        {
                          id: 'delete',
                          label: 'Delete Environment',
                          icon: 'trash',
                          variant: 'danger',
                          dividerBefore: true,
                          onSelect: () => {
                            void (async () => {
                              const ok = await confirm({
                                title: 'Delete environment?',
                                description: `This action cannot be undone. All variables and AES-256-GCM encrypted secrets in "${activeEnv.name}" will be permanently deleted.`,
                                confirmLabel: 'Delete Environment',
                              })
                              if (ok) deleteMutation.mutate(activeEnv.id)
                            })()
                          },
                        },
                      ]}
                    />
                  ) : null}
                </div>
              </div>

              <div className="w-full border border-[var(--color-border)] rounded-[var(--radius-md)] overflow-hidden">
              <div className="grid grid-cols-[36px_1fr_1.3fr_96px_36px] items-center h-7 px-2.5 bg-[var(--color-surface-secondary)] border-b border-[var(--color-border)] text-[11px] font-semibold text-[var(--color-text-secondary)]">
                <span className="text-center">On</span>
                <span className="px-2">Variable Key</span>
                <span className="px-2">Value</span>
                <span className="px-2">Storage Type</span>
                <span className="sr-only">Remove</span>
              </div>

              {editVars.length === 0 ? (
                <div className="py-6 text-center text-xs text-[var(--color-text-muted)]">
                  No variables configured in <strong>{activeEnv.name}</strong> yet. Click &ldquo;Add
                  Variable&rdquo; below to add your first key-value pair.
                </div>
              ) : (
                <div className="divide-y divide-[var(--color-border)]">
                  {editVars.map((v, idx) => (
                    <div
                      key={v.id ?? `idx-${idx}`}
                      className="grid grid-cols-[36px_1fr_1.3fr_96px_36px] items-center px-2.5 py-1 gap-1.5"
                    >
                      <div className="flex justify-center">
                        <input
                          type="checkbox"
                          checked={v.enabled}
                          aria-label="Enable variable"
                          onChange={(e) => {
                            const next = [...editVars]
                            next[idx] = { ...v, enabled: e.target.checked }
                            setEditVars(next)
                            setIsDirty(true)
                          }}
                          className="w-3.5 h-3.5 accent-[var(--color-primary)] cursor-pointer"
                        />
                      </div>
                      <input
                        type="text"
                        value={v.key}
                        placeholder="apiBaseUrl or secretApiKey"
                        aria-label="Variable key"
                        onChange={(e) => {
                          const next = [...editVars]
                          next[idx] = { ...v, key: e.target.value }
                          setEditVars(next)
                          setIsDirty(true)
                        }}
                        className="h-7 px-2 text-xs font-mono rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-text)] focus:border-[var(--color-primary)] outline-none"
                      />
                      <input
                        type={v.isSecret ? 'password' : 'text'}
                        value={v.value}
                        placeholder={
                          v.isSecret && v.keepExistingSecret
                            ? '•••••••• (Saved — enter new value to update)'
                            : 'Value'
                        }
                        aria-label="Variable value"
                        onChange={(e) => {
                          const next = [...editVars]
                          next[idx] = { ...v, value: e.target.value }
                          setEditVars(next)
                          setIsDirty(true)
                        }}
                        className="h-7 px-2 text-xs font-mono rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-text)] focus:border-[var(--color-primary)] outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const next = [...editVars]
                          next[idx] = { ...v, isSecret: !v.isSecret }
                          setEditVars(next)
                          setIsDirty(true)
                        }}
                        className={cn(
                          'h-7 px-2 rounded-[var(--radius-sm)] border text-[11px] font-medium inline-flex items-center justify-center gap-1 cursor-pointer transition-colors',
                          v.isSecret
                            ? 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)] border-[var(--color-primary)]'
                            : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]',
                        )}
                      >
                        <Icon name={v.isSecret ? 'lock' : 'globe'} size={11} />
                        <span>{v.isSecret ? 'Secret' : 'Plain'}</span>
                      </button>
                      <button
                        type="button"
                        aria-label="Remove variable"
                        onClick={async () => {
                          const ok = await confirm({
                            title: 'Are you sure?',
                            description: v.key.trim()
                              ? `This action cannot be undone. Variable "${v.key.trim()}" will be removed.`
                              : 'This action cannot be undone. All values associated with this field will be lost.',
                            confirmLabel: 'Delete field',
                          })
                          if (!ok) return
                          setEditVars(editVars.filter((_, i) => i !== idx))
                          setIsDirty(true)
                        }}
                        className="w-8 h-8 inline-flex items-center justify-center rounded-[var(--radius-md)] text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)] cursor-pointer"
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-4 flex-wrap pt-1">
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Icon name="plus" size={13} />}
                onClick={() =>
                  setEditVars([...editVars, { key: '', value: '', isSecret: false, enabled: true }])
                }
              >
                Add Variable
              </Button>

              <div className="flex items-center gap-2 flex-wrap text-[11px] text-[var(--color-text-muted)]">
                <span>Built-in dynamic tokens:</span>
                <code className="px-1.5 py-0.5 rounded bg-[var(--color-surface-secondary)] border border-[var(--color-border)] text-[var(--color-text-secondary)]">
                  {'{{$uuid}}'}
                </code>
                <code className="px-1.5 py-0.5 rounded bg-[var(--color-surface-secondary)] border border-[var(--color-border)] text-[var(--color-text-secondary)]">
                  {'{{$timestamp}}'}
                </code>
                <code className="px-1.5 py-0.5 rounded bg-[var(--color-surface-secondary)] border border-[var(--color-border)] text-[var(--color-text-secondary)]">
                  {'{{$isoTimestamp}}'}
                </code>
                <code className="px-1.5 py-0.5 rounded bg-[var(--color-surface-secondary)] border border-[var(--color-border)] text-[var(--color-text-secondary)]">
                  {'{{$randomInt}}'}
                </code>
              </div>
            </div>
          </Card>
        ) : null}
      </main>

      {/* Create Environment Dialog */}
      <Dialog
        open={createOpen}
        title="Create Environment"
        description="Group variables for Staging, Production, or Internal Testing."
        onClose={() => setCreateOpen(false)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Environment Name"
            value={newEnvName}
            onChange={(e) => setNewEnvName(e.target.value)}
            placeholder="Staging EU"
            required
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newEnvName.trim()}
              isLoading={createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              Create
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Import .env Dialog */}
      <Dialog
        open={importOpen}
        title="Import .env File"
        description="Paste your .env variables below."
        onClose={() => setImportOpen(false)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Environment Name"
            value={dotenvName}
            onChange={(e) => setDotenvName(e.target.value)}
            placeholder="Imported Production"
            required
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="dotenv-area" className="text-sm font-medium">
              .env Content
            </label>
            <textarea
              id="dotenv-area"
              rows={6}
              value={dotenvContent}
              onChange={(e) => setDotenvContent(e.target.value)}
              placeholder={'API_BASE_URL=https://api.example.com\nAPI_SECRET_TOKEN=sk_live_12345'}
              className="w-full p-3.5 text-xs font-mono rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-background)] text-[var(--color-text)] focus:border-[var(--color-primary)] outline-none"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!dotenvName.trim() || !dotenvContent.trim()}
              isLoading={importDotenvMutation.isPending}
              onClick={() => importDotenvMutation.mutate()}
            >
              Import
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Compare Environments Modal */}
      <Dialog
        open={compareOpen}
        title="Compare Environments"
        description="Spot missing keys or mismatched values across environments before deployment."
        maxWidthClass="max-w-2xl"
        onClose={() => setCompareOpen(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select
              label="Base Environment"
              value={compareLeftId}
              onValueChange={setCompareLeftId}
              options={environments.map((e) => ({ value: e.id, label: e.name }))}
            />
            <Select
              label="Target Environment"
              value={compareRightId}
              onValueChange={setCompareRightId}
              options={environments.map((e) => ({ value: e.id, label: e.name }))}
            />
          </div>

          <DataTable<{
            key: string
            left: { isSecret: boolean; value: string } | null
            right: { isSecret: boolean; value: string } | null
            state: 'missing_right' | 'missing_left' | 'different' | 'same'
          }>
            compact
            defaultPageSize={10}
            server={{
              queryKey: ['environments', workspaceId, 'compare'],
              endpoint: '/api/v1/environments/compare',
              params: {
                leftId: compareLeftId,
                rightId: compareRightId,
              },
              enabled: Boolean(compareOpen && compareLeftId && compareRightId),
            }}
            getRowKey={(r) => r.key}
            searchPlaceholder="Search variable keys or status..."
            emptyMessage="No variables found in the selected environments."
            columns={[
              {
                id: 'key',
                header: 'Key',
                cellClassName: 'font-mono font-semibold',
                cell: (r) => r.key,
              },
              {
                id: 'left',
                header: 'Base',
                cellClassName: 'font-mono text-[var(--color-text-secondary)] truncate max-w-[160px]',
                cell: (r) =>
                  !r.left ? '—' : r.left.isSecret ? '••••••••' : r.left.value || '(empty)',
              },
              {
                id: 'right',
                header: 'Target',
                cellClassName: 'font-mono text-[var(--color-text-secondary)] truncate max-w-[160px]',
                cell: (r) =>
                  !r.right ? '—' : r.right.isSecret ? '••••••••' : r.right.value || '(empty)',
              },
              {
                id: 'status',
                header: 'Status',
                cell: (r) =>
                  r.state === 'same' ? (
                    <Badge variant="success">Match</Badge>
                  ) : r.state === 'different' ? (
                    <Badge variant="info">Differs</Badge>
                  ) : (
                    <Badge variant="warning">
                      {r.state === 'missing_right' ? 'Missing in Target' : 'Missing in Base'}
                    </Badge>
                  ),
              },
            ]}
          />
        </div>
      </Dialog>

      <Dialog
        open={Boolean(renameEnvTarget)}
        title="Rename Environment"
        onClose={() => setRenameEnvTarget(null)}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Environment Name"
            value={renameEnvDraft}
            onChange={(e) => setRenameEnvDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renameEnvDraft.trim() && !renameEnvMutation.isPending) {
                e.preventDefault()
                renameEnvMutation.mutate()
              }
            }}
            required
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setRenameEnvTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!renameEnvDraft.trim()}
              isLoading={renameEnvMutation.isPending}
              onClick={() => renameEnvMutation.mutate()}
            >
              Save Name
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
