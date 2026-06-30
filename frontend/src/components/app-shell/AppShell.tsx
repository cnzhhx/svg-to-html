import type { ReactNode } from 'react'

export function AppShell({
  chat,
  main,
  sidebar,
}: {
  chat: ReactNode
  main: ReactNode
  sidebar: ReactNode
}) {
  return (
    <>
      <div className="app-shell" id="appShell">
        {sidebar}
        <main className="main-panel">{main}</main>
      </div>
      {chat}
    </>
  )
}
