'use client'

import type { KeyValueItem, RequestAuthConfig } from '@meofast/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Dialog,
  Icon,
  Input,
  Select,
  Tabs,
  useToast,
  VariableInput,
} from '@/components/ui'
import { KeyValueEditor } from '@/features/client/components/KeyValueEditor'
import { useWorkspaceVariables } from '@/features/client/hooks/useWorkspaceVariables'
import { apiRequest } from '@/lib/api-client'

export interface SettingsTargetEntity {
  kind: 'collection' | 'folder'
  id: string
  collectionId: string
  name: string
  description: string
  variables: KeyValueItem[]
  auth: RequestAuthConfig
  headers: KeyValueItem[]
}

interface CollectionSettingsModalProps {
  open: boolean
  workspaceId: string
  target: SettingsTargetEntity | null
  onClose: () => void
}

export function CollectionSettingsModal({
  open,
  workspaceId,
  target,
  onClose,
}: CollectionSettingsModalProps) {
  const queryClient = useQueryClient()
  const toast = useToast()

  const [section, setSection] = useState<'auth' | 'headers' | 'variables' | 'general'>('auth')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [auth, setAuth] = useState<RequestAuthConfig>({ type: 'none' })
  const [headers, setHeaders] = useState<KeyValueItem[]>([])
  const [variables, setVariables] = useState<KeyValueItem[]>([])

  const {
    variables: workspaceVariables,
    defaultTargetEnvId,
    defaultTargetLabel,
    saveVariable,
  } = useWorkspaceVariables(
    workspaceId,
    target?.collectionId ?? null,
    target?.kind === 'folder' ? target.id : null,
  )

  useEffect(() => {
    if (!target || !open) return
    setName(target.name)
    setDescription(target.description ?? '')
    setAuth(
      target.auth ?? (target.kind === 'folder' ? { type: 'inherit' } : { type: 'none' }),
    )
    setHeaders(target.headers ?? [])
    setVariables(target.variables ?? [])
    setSection('auth')
  }, [target, open])

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!target) return
      const endpoint =
        target.kind === 'collection'
          ? `/api/v1/collections/${target.id}`
          : `/api/v1/folders/${target.id}`
      await apiRequest(endpoint, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim() || target.name,
          description,
          auth,
          headers,
          variables,
        }),
      })
    },
    onSuccess: async () => {
      toast.success(
        target?.kind === 'collection' ? 'Collection settings saved' : 'Folder settings saved',
        'Auth, inherited headers, and variables updated.',
      )
      await queryClient.invalidateQueries({ queryKey: ['workspace-tree', workspaceId] })
      onClose()
    },
    onError: (err) => {
      toast.error('Failed to save settings', err instanceof Error ? err.message : undefined)
    },
  })

  if (!target) return null

  const authOptions = [
    ...(target.kind === 'folder'
      ? [{ value: 'inherit', label: 'Inherit Auth from Parent' }]
      : []),
    { value: 'none', label: 'No Authentication' },
    { value: 'bearer', label: 'Bearer / JWT Token' },
    { value: 'basic', label: 'Basic Auth' },
    { value: 'apikey', label: 'API Key' },
    { value: 'oauth2', label: 'OAuth 2.0 Access Token' },
    { value: 'custom', label: 'Custom Header' },
  ]

  const handleAuthTypeChange = (val: string) => {
    const nextType = val as RequestAuthConfig['type']
    const defaults: Record<RequestAuthConfig['type'], RequestAuthConfig> = {
      inherit: { type: 'inherit' },
      none: { type: 'none' },
      bearer: { type: 'bearer', token: '', prefix: 'Bearer' },
      basic: { type: 'basic', username: '', password: '' },
      apikey: { type: 'apikey', key: 'X-API-Key', value: '', in: 'header' },
      oauth2: { type: 'oauth2', accessToken: '', headerPrefix: 'Bearer' },
      aws_sigv4: {
        type: 'aws_sigv4',
        accessKeyId: '',
        secretAccessKey: '',
        region: 'us-east-1',
        service: 'execute-api',
      },
      digest: { type: 'digest', username: '', password: '' },
      oauth1: { type: 'oauth1', consumerKey: '', consumerSecret: '' },
      custom: { type: 'custom', headerName: 'Authorization', headerValue: '' },
    }
    setAuth(defaults[nextType])
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidthClass="max-w-2xl"
      title={`${target.kind === 'collection' ? 'Collection' : 'Folder'} Settings — ${target.name}`}
      description="Configure shared authentication, inherited headers, and scoped variables for child requests."
    >
      <div className="w-full flex flex-col gap-4">
        <Tabs
          items={[
            {
              id: 'auth',
              label: 'Auth',
              count: auth.type !== 'none' && auth.type !== 'inherit' ? 1 : 0,
            },
            {
              id: 'headers',
              label: 'Headers',
              count: headers.filter((h) => h.enabled && h.key.trim()).length,
            },
            {
              id: 'variables',
              label: 'Variables',
              count: variables.filter((v) => v.enabled && v.key.trim()).length,
            },
            { id: 'general', label: 'General' },
          ]}
          activeId={section}
          onChange={(id) => setSection(id as typeof section)}
          rightSlot={
            auth.type !== 'none' ? (
              <Badge variant="primary">{auth.type.toUpperCase()}</Badge>
            ) : null
          }
        />

        {section === 'auth' ? (
          <div className="w-full flex flex-col gap-3.5">
            <Select
              label="Default Authentication for Child Requests"
              value={auth.type}
              onValueChange={handleAuthTypeChange}
              options={authOptions}
            />

            <p className="text-xs text-[var(--color-text-secondary)]">
              Child requests with Authentication set to{' '}
              <code className="font-mono text-[var(--color-primary)]">Inherit Auth from Parent</code>{' '}
              will automatically apply this configuration when sent.
            </p>

            {auth.type === 'bearer' ? (
              <div className="grid grid-cols-1 sm:grid-cols-[150px_1fr] gap-3">
                <Input
                  label="Prefix"
                  mono
                  value={auth.prefix}
                  onChange={(e) => setAuth({ ...auth, prefix: e.target.value })}
                />
                <VariableInput
                  label="Token"
                  value={auth.token}
                  placeholder="{{accessToken}} or paste JWT..."
                  variables={workspaceVariables}
                  defaultTargetLabel={defaultTargetLabel}
                  defaultTargetEnvId={defaultTargetEnvId}
                  onSaveVariable={saveVariable}
                  onChange={(e) => setAuth({ ...auth, token: e.target.value })}
                />
              </div>
            ) : null}

            {auth.type === 'basic' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <VariableInput
                  label="Username"
                  value={auth.username}
                  placeholder="{{basicUsername}}"
                  variables={workspaceVariables}
                  defaultTargetLabel={defaultTargetLabel}
                  defaultTargetEnvId={defaultTargetEnvId}
                  onSaveVariable={saveVariable}
                  onChange={(e) => setAuth({ ...auth, username: e.target.value })}
                />
                <VariableInput
                  label="Password"
                  type="password"
                  value={auth.password}
                  placeholder="{{basicPassword}}"
                  variables={workspaceVariables}
                  defaultTargetLabel={defaultTargetLabel}
                  defaultTargetEnvId={defaultTargetEnvId}
                  onSaveVariable={saveVariable}
                  onChange={(e) => setAuth({ ...auth, password: e.target.value })}
                />
              </div>
            ) : null}

            {auth.type === 'apikey' ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Input
                  label="Key Name"
                  mono
                  value={auth.key}
                  onChange={(e) => setAuth({ ...auth, key: e.target.value })}
                />
                <VariableInput
                  label="Key Value"
                  value={auth.value}
                  placeholder="{{apiKey}}"
                  variables={workspaceVariables}
                  defaultTargetLabel={defaultTargetLabel}
                  defaultTargetEnvId={defaultTargetEnvId}
                  onSaveVariable={saveVariable}
                  onChange={(e) => setAuth({ ...auth, value: e.target.value })}
                />
                <Select
                  label="Send In"
                  value={auth.in}
                  onValueChange={(val) => setAuth({ ...auth, in: val as 'header' | 'query' })}
                  options={[
                    { value: 'header', label: 'Header' },
                    { value: 'query', label: 'Query Param' },
                  ]}
                />
              </div>
            ) : null}

            {auth.type === 'oauth2' ? (
              <div className="grid grid-cols-1 sm:grid-cols-[150px_1fr] gap-3">
                <Input
                  label="Header Prefix"
                  mono
                  value={auth.headerPrefix}
                  onChange={(e) => setAuth({ ...auth, headerPrefix: e.target.value })}
                />
                <VariableInput
                  label="Access Token"
                  value={auth.accessToken}
                  placeholder="{{oauthAccessToken}}"
                  variables={workspaceVariables}
                  defaultTargetLabel={defaultTargetLabel}
                  defaultTargetEnvId={defaultTargetEnvId}
                  onSaveVariable={saveVariable}
                  onChange={(e) => setAuth({ ...auth, accessToken: e.target.value })}
                />
              </div>
            ) : null}

            {auth.type === 'custom' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input
                  label="Header Name"
                  mono
                  value={auth.headerName}
                  onChange={(e) => setAuth({ ...auth, headerName: e.target.value })}
                />
                <VariableInput
                  label="Header Value"
                  value={auth.headerValue}
                  placeholder="{{customAuthHeader}}"
                  variables={workspaceVariables}
                  defaultTargetLabel={defaultTargetLabel}
                  defaultTargetEnvId={defaultTargetEnvId}
                  onSaveVariable={saveVariable}
                  onChange={(e) => setAuth({ ...auth, headerValue: e.target.value })}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {section === 'headers' ? (
          <div className="w-full flex flex-col gap-2.5">
            <p className="text-xs text-[var(--color-text-secondary)]">
              Enabled headers are automatically injected into every request inside this{' '}
              {target.kind}. Request-level headers with the same name override inherited values.
            </p>
            <KeyValueEditor
              items={headers}
              onChange={setHeaders}
              keyPlaceholder="Header (e.g. X-Tenant-ID)"
              valuePlaceholder="Value (supports {{variable}})"
              addLabel="Add Inherited Header"
              variables={workspaceVariables}
              defaultTargetLabel={defaultTargetLabel}
              defaultTargetEnvId={defaultTargetEnvId}
              onSaveVariable={saveVariable}
            />
          </div>
        ) : null}

        {section === 'variables' ? (
          <div className="w-full flex flex-col gap-2.5">
            <p className="text-xs text-[var(--color-text-secondary)]">
              Variables defined here are available as <code className="font-mono">{'{{key}}'}</code>{' '}
              across requests in this {target.kind}. Active Environment variables override{' '}
              {target.kind} variables.
            </p>
            <KeyValueEditor
              items={variables}
              onChange={setVariables}
              keyPlaceholder="Variable name (e.g. BASE_URL)"
              valuePlaceholder="Default value"
              addLabel="Add Scoped Variable"
              variables={workspaceVariables}
              defaultTargetLabel={defaultTargetLabel}
              defaultTargetEnvId={defaultTargetEnvId}
              onSaveVariable={saveVariable}
            />
          </div>
        ) : null}

        {section === 'general' ? (
          <div className="w-full flex flex-col gap-3.5">
            <Input
              label={target.kind === 'collection' ? 'Collection Name' : 'Folder Name'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                Description
              </label>
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Document purpose, base URL conventions, or authentication notes..."
                className="w-full p-2.5 text-xs leading-relaxed rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-background)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus-visible:outline-none focus-visible:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/16 resize-y transition-all"
              />
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--color-border)]">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            isLoading={saveMutation.isPending}
            leftIcon={<Icon name="save" size={14} />}
            onClick={() => saveMutation.mutate()}
          >
            Save Settings
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
