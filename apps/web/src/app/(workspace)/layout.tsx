import type { ReactNode } from 'react'
import { WorkbenchShell } from '@/features/client/WorkbenchShell'

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <WorkbenchShell />
      {children}
    </>
  )
}
