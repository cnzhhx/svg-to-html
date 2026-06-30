import type { ReactNode } from 'react'

export function AppShell({
  chat,
  main,
  sidebar,
  sidebarCollapsed = false,
}: {
  chat?: ReactNode
  main: ReactNode
  sidebar: ReactNode
  sidebarCollapsed?: boolean
}) {
  return (
    <>
      <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`} id="appShell">
        {sidebarCollapsed ? null : sidebar}
        <main className="main-panel">{main}</main>
      </div>
      {chat}
    </>
  )
}
