'use client'

import { useMemo, useState } from 'react'
import { Button, CodeEditor, Dialog, Icon, Tabs, useToast } from '@/components/ui'
import {
  generateGoStructFromJson,
  generateJsonSchemaFromJson,
  generateTypeScriptFromJson,
  generateZodFromJson,
} from '../utils/type-generator'

export function TypeGeneratorModal({
  open,
  onClose,
  jsonBody,
  requestName,
  onApplyJsonSchema,
}: {
  open: boolean
  onClose: () => void
  jsonBody: string
  requestName: string
  onApplyJsonSchema: (schema: string) => void
}) {
  const toast = useToast()
  const [target, setTarget] = useState<'typescript' | 'zod' | 'jsonschema' | 'go'>('typescript')

  const parsedValue = useMemo(() => {
    try {
      return { ok: true as const, data: JSON.parse(jsonBody) as unknown }
    } catch {
      return { ok: false as const, data: null }
    }
  }, [jsonBody])

  const generatedCode = useMemo(() => {
    if (!parsedValue.ok) {
      return '// Response body is not valid JSON.'
    }
    const cleanName = requestName || 'ApiResponse'
    switch (target) {
      case 'typescript':
        return generateTypeScriptFromJson(parsedValue.data, cleanName)
      case 'zod':
        return generateZodFromJson(parsedValue.data, cleanName)
      case 'jsonschema':
        return generateJsonSchemaFromJson(parsedValue.data)
      case 'go':
        return generateGoStructFromJson(parsedValue.data, cleanName)
    }
  }, [parsedValue, requestName, target])

  const handleCopy = async () => {
    await navigator.clipboard.writeText(generatedCode)
    toast.success('Copied to clipboard', `${target.toUpperCase()} definition copied.`)
  }

  const handleApplySchema = () => {
    if (!parsedValue.ok) return
    const schema = generateJsonSchemaFromJson(parsedValue.data)
    onApplyJsonSchema(schema)
    toast.success('Schema applied to request', 'Contract validation is now active on the Schema tab.')
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Generate Types & Validation Schema"
      description="Inferred directly from the live JSON response payload."
      maxWidthClass="max-w-2xl"
    >
      <div className="flex flex-col gap-3.5">
        <Tabs
          activeId={target}
          onChange={(id) => setTarget(id as typeof target)}
          items={[
            { id: 'typescript', label: 'TypeScript' },
            { id: 'zod', label: 'Zod Schema' },
            { id: 'jsonschema', label: 'JSON Schema' },
            { id: 'go', label: 'Go Struct' },
          ]}
          rightSlot={
            <div className="flex items-center gap-2">
              {parsedValue.ok ? (
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<Icon name="shield" size={13} />}
                  onClick={handleApplySchema}
                >
                  Apply to Schema Tab
                </Button>
              ) : null}
              <Button
                size="sm"
                leftIcon={<Icon name="copy" size={13} />}
                onClick={() => {
                  void handleCopy()
                }}
              >
                Copy
              </Button>
            </div>
          }
        />

        <CodeEditor
          language={target === 'jsonschema' ? 'json' : 'javascript'}
          value={generatedCode}
          readOnly
          minHeight="320px"
          ariaLabel="Generated types output"
        />
      </div>
    </Dialog>
  )
}
