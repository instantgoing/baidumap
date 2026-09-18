import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default ({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const proxyTarget = env.VITE_DEV_API_TARGET
  const base = env.VITE_BASE_PATH || '/'
  return defineConfig({
    base,
    plugins: [react()],
    server: proxyTarget ? { proxy: { '/api': { target: proxyTarget, changeOrigin: true } } } : undefined,
  })
}
