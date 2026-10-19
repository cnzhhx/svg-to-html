import { apiJson } from './http'

const ADMIN_HASH_KEY = 'adminKey'

export const bootstrapAdminSessionFromHash = async () => {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
  if (!hash) return
  const params = new URLSearchParams(hash)
  const key = params.get(ADMIN_HASH_KEY)
  if (!key) return

  params.delete(ADMIN_HASH_KEY)
  const remainingHash = params.toString()
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}${remainingHash ? `#${remainingHash}` : ''}`,
  )
  await apiJson<{ adminMode: boolean }>('/api/admin/session', {
    body: JSON.stringify({ key }),
    method: 'POST',
  })
}

export const endAdminSession = () =>
  apiJson<{ adminMode: boolean }>('/api/admin/session', { method: 'DELETE' })
