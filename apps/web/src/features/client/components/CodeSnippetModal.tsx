'use client'

import { useState } from 'react'
import { Button, CodeEditor, Dialog, Icon, Select } from '@/components/ui'
import type { RequestTab } from '../store/useWorkbenchStore'
import {
  generateClientSnippet,
  SNIPPET_LANGUAGES,
  type SnippetLanguage,
} from '../utils/code-snippets'

interface CodeSnippetModalProps {
  open: boolean
  onClose: () => void
  tab: RequestTab
}

export function CodeSnippetModal({ open, onClose, tab }: CodeSnippetModalProps) {
  const [lang, setLang] = useState<SnippetLanguage>('curl')
  const [copied, setCopied] = useState(false)

  const code = generateClientSnippet(tab, lang)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Dialog open={open} title="Generate Code Snippet" maxWidthClass="max-w-2xl" onClose={onClose}>
      <div className="flex flex-col gap-3.5">
        <div className="flex items-end justify-between gap-3">
          <div className="w-64">
            <Select
              size="sm"
              label="Target Language"
              value={lang}
              onValueChange={(v) => setLang(v as SnippetLanguage)}
              options={SNIPPET_LANGUAGES}
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Icon name={copied ? 'check' : 'copy'} size={13} />}
            onClick={handleCopy}
          >
            {copied ? 'Copied' : 'Copy Code'}
          </Button>
        </div>

        <CodeEditor
          readOnly
          language={lang === 'fetch' || lang === 'node' ? 'javascript' : 'text'}
          value={code}
          minHeight="220px"
          ariaLabel="Generated client code"
        />
      </div>
    </Dialog>
  )
}
