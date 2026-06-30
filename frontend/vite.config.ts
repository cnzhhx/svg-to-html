import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backendPort = Number(process.env.PORT || 80)
const backendTarget = `http://127.0.0.1:${Number.isFinite(backendPort) && backendPort > 0 ? backendPort : 80}`

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
    proxy: {
      '/transformer/api': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/transformer/files': {
        target: backendTarget,
        changeOrigin: true,
      },
    },
  },
})
