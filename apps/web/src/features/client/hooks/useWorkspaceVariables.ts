'use client'

import type { KeyValueItem } from '@meofast/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { type ResolvedVariableItem, useToast } from '@/components/ui'
import { apiRequest } from '@/lib/api-client'
import { useWorkbenchStore } from '../store/useWorkbenchStore'

interface EnvRecord {
  id: string
  workspaceId: string
  name: string
  isGlobal: boolean
  variables: Array<{
    id?: string
    key: string
    value: string
    isSecret: boolean
    hasSecretValue?: boolean
    enabled: boolean
  }>
}

interface TreeCollectionRecord {
  id: string
  name: string
  variables?: KeyValueItem[]
  folders?: Array<{
    id: string
    parentFolderId?: string | null
    name: string
    variables?: KeyValueItem[]
  }>
}

const DYNAMIC_VARIABLES: ResolvedVariableItem[] = [
  {
    key: '$uuid',
    value: 'Auto-generated UUID v4 per request',
    scope: 'dynamic',
    scopeLabel: 'Dynamic',
    environmentId: null,
    editable: false,
  },
  {
    key: '$timestamp',
    value: 'Unix epoch seconds (e.g. 1731830400)',
    scope: 'dynamic',
    scopeLabel: 'Dynamic',
    environmentId: null,
    editable: false,
  },
  {
    key: '$isoTimestamp',
    value: 'ISO-8601 UTC timestamp',
    scope: 'dynamic',
    scopeLabel: 'Dynamic',
    environmentId: null,
    editable: false,
  },
  {
    key: '$randomInt',
    value: 'Random integer (1 – 10000)',
    scope: 'dynamic',
    scopeLabel: 'Dynamic',
    environmentId: null,
    editable: false,
  },
]

export function useWorkspaceVariables(
  workspaceId: string,
  collectionId?: string | null,
  folderId?: string | null,
) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const activeEnvironmentId = useWorkbenchStore((s) => s.activeEnvironmentId)

  const envsQuery = useQuery({
    queryKey: ['environments', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () =>
      apiRequest<{ environments: EnvRecord[] }>(
        `/api/v1/workspaces/${workspaceId}/environments`,
      ),
  })

  const treeQuery = useQuery({
    queryKey: ['workspace-tree', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () =>
      apiRequest<{ collections: TreeCollectionRecord[] }>(
        `/api/v1/workspaces/${workspaceId}/tree`,
      ),
  })

  const environments = envsQuery.data?.environments ?? []
  const globalEnv = environments.find((e) => e.isGlobal) ?? null
  const activeEnv =
    activeEnvironmentId
      ? (environments.find((e) => e.id === activeEnvironmentId && !e.isGlobal) ?? null)
      : null

  const defaultTargetEnvId = activeEnv?.id ?? globalEnv?.id ?? null
  const defaultTargetLabel = activeEnv ? activeEnv.name : 'Global'

  const variables = useMemo<ResolvedVariableItem[]>(() => {
    const merged = new Map<string, ResolvedVariableItem>()

    // 1. Global Variables
    if (globalEnv) {
      for (const v of globalEnv.variables) {
        const k = v.key.trim()
        if (!v.enabled || !k) continue
        merged.set(k, {
          key: k,
          value: v.value,
          scope: 'global',
          scopeLabel: 'Global',
          environmentId: globalEnv.id,
          isSecret: v.isSecret,
          hasSecretValue: v.hasSecretValue,
          editable: true,
        })
      }
    }

    // 2. Collection & Folder Variables
    if (collectionId) {
      const col = (treeQuery.data?.collections ?? []).find((c) => c.id === collectionId)
      if (col?.variables) {
        for (const cv of col.variables) {
          const k = cv.key.trim()
          if (!cv.enabled || !k) continue
          merged.set(k, {
            key: k,
            value: cv.value,
            scope: 'collection',
            scopeLabel: col.name,
            environmentId: null,
            editable: false,
          })
        }
      }
      if (folderId && col?.folders) {
        const chain: Array<{ id: string; name: string; variables?: KeyValueItem[] }> = []
        const seen = new Set<string>()
        let cursor: string | null | undefined = folderId
        while (cursor && !seen.has(cursor) && seen.size < 16) {
          seen.add(cursor)
          const found = col.folders.find((f) => f.id === cursor)
          if (!found) break
          chain.unshift(found)
          cursor = found.parentFolderId
        }
        for (const folder of chain) {
          if (folder.variables) {
            for (const fv of folder.variables) {
              const k = fv.key.trim()
              if (!fv.enabled || !k) continue
              merged.set(k, {
                key: k,
                value: fv.value,
                scope: 'folder',
                scopeLabel: folder.name,
                environmentId: null,
                editable: false,
              })
            }
          }
        }
      }
    }

    // 3. Active Environment Variables (highest user scope priority)
    if (activeEnv) {
      for (const v of activeEnv.variables) {
        const k = v.key.trim()
        if (!v.enabled || !k) continue
        merged.set(k, {
          key: k,
          value: v.value,
          scope: 'environment',
          scopeLabel: activeEnv.name,
          environmentId: activeEnv.id,
          isSecret: v.isSecret,
          hasSecretValue: v.hasSecretValue,
          editable: true,
        })
      }
    }

    // Put user-defined variables first (Active Env first, then Folder/Collection/Global), followed by Dynamic built-ins
    const userItems = Array.from(merged.values()).sort((a, b) => {
      if (a.scope === 'environment' && b.scope !== 'environment') return -1
      if (a.scope !== 'environment' && b.scope === 'environment') return 1
      return a.key.localeCompare(b.key)
    })

    return [...userItems, ...DYNAMIC_VARIABLES]
  }, [globalEnv, activeEnv, collectionId, folderId, treeQuery.data?.collections])

  const upsertVariableMutation = useMutation({
    mutationFn: async (input: { key: string; value: string; environmentId: string | null }) => {
      return apiRequest<{
        ok: boolean
        environmentId: string
        environmentName: string
        isGlobal: boolean
      }>(`/api/v1/workspaces/${workspaceId}/variables`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      })
    },
    onSuccess: async (res, vars) => {
      toast.success(
        `Variable "${vars.key}" saved`,
        `Updated in ${res.isGlobal ? 'Global Variables' : res.environmentName}.`,
      )
      await queryClient.invalidateQueries({ queryKey: ['environments', workspaceId] })
    },
    onError: (err) => {
      toast.error('Failed to update variable', err instanceof Error ? err.message : undefined)
    },
  })

  return {
    variables,
    defaultTargetEnvId,
    defaultTargetLabel,
    saveVariable: async (input: { key: string; value: string; environmentId: string | null }) => {
      await upsertVariableMutation.mutateAsync(input)
    },
  }
}
