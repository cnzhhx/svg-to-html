import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AdminPage from './components/admin/AdminPage'
import { bootstrapAdminSessionFromHash } from './api/admin'

const root = ReactDOM.createRoot(document.getElementById('root')!)

const render = (initialError?: string) => {
  root.render(
    <React.StrictMode>
      {/^\/transformer\/(setup|login|admin\/settings)\/?$/.test(window.location.pathname)
        ? <AdminPage /> : <App initialError={initialError} />}
    </React.StrictMode>,
  )
}

void bootstrapAdminSessionFromHash()
  .then(() => render())
  .catch((error) => render(error instanceof Error ? error.message : String(error)))
