import path from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // 这里只跑新增 smoke 用例，避免和现有 node:test 路线混用。
    include: [
      'tests/server-app.smoke.test.ts',
      'tests/app-shell.smoke.test.tsx',
    ],
    environment: 'node',
  },
})
