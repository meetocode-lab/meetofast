import { notFound, redirect } from 'next/navigation'
import { isSidebarSection } from '@/features/client/store/workspace-routes'

export default async function WorkspaceSectionPage({
  params,
}: {
  params: Promise<{ section?: string[] }>
}) {
  const { section } = await params

  if (!section || section.length === 0) {
    redirect('/collections')
  }

  const primary = section[0]
  const isNestedAdminRoleRoute =
    primary === 'admin' && section[1] === 'roles' && section.length <= 4
  if (!primary || !isSidebarSection(primary) || (section.length > 2 && !isNestedAdminRoleRoute)) {
    notFound()
  }

  return null
}
