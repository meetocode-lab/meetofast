export const SIDEBAR_SECTIONS = [
  'collections',
  'docs',
  'mocks',
  'webhooks',
  'monitors',
  'environments',
  'history',
  'admin',
  'profile',
] as const

export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number]

export function isSidebarSection(value: string): value is SidebarSection {
  return (SIDEBAR_SECTIONS as readonly string[]).includes(value)
}

export function buildSectionPath(section: SidebarSection, subTab?: string | null): string {
  if (subTab && subTab.trim()) {
    return `/${section}/${subTab.trim()}`
  }
  return `/${section}`
}

export function parseWorkspacePath(
  pathname: string | null | undefined,
): { section: SidebarSection; subTab: string | null } | null {
  if (!pathname || pathname === '/') {
    return { section: 'collections', subTab: null }
  }
  const parts = pathname.split('/').filter(Boolean)
  const first = parts[0]
  if (!first || !isSidebarSection(first)) {
    return null
  }
  return {
    section: first,
    subTab: parts.length > 1 ? parts.slice(1).join('/') : null,
  }
}
