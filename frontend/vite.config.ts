import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const frontendRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(frontendRoot, '..')

const parseEnvValue = (raw: string) => {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

const readRootEnvValue = (key: string) => {
  if (process.env[key] !== undefined) return process.env[key]

  const envPath = path.join(repoRoot, '.env')
  if (!existsSync(envPath)) return undefined

  const content = readFileSync(envPath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const equalsIndex = trimmed.indexOf('=')
    if (equalsIndex <= 0) continue

    const envKey = trimmed.slice(0, equalsIndex).trim()
    if (envKey !== key) continue

    return parseEnvValue(trimmed.slice(equalsIndex + 1))
  }

  return undefined
}

export default defineConfig({
  base: '/transformer/',
  build: {
    emptyOutDir: true,
    outDir: 'public',
  },
  plugins: [react()],
  publicDir: false,
  server: {
    port: 5173,
    proxy: (() => {
      const backendPort = Number(readRootEnvValue('PORT') || 80)
      const backendTarget = `http://127.0.0.1:${Number.isFinite(backendPort) && backendPort > 0 ? backendPort : 80}`

      return {
        '/transformer/api': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/transformer/files': {
          target: backendTarget,
          changeOrigin: true,
        },
      }
    })(),
  },
})
