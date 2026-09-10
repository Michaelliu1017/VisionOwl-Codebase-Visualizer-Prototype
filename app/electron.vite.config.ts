import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'backend/main.ts') }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'backend/preload.ts') }
    }
  },
  renderer: {
    root: 'frontend',
    publicDir: resolve(__dirname, 'frontend/assets'),
    plugins: [react()],
    server: {
      // 允许引用仓库根下 skills/ 内的主题 css
      fs: { allow: [resolve(__dirname, '..')] }
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'frontend/index.html') }
    }
  }
})
