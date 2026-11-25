import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readdir, readFile } from 'node:fs/promises'
import path from 'path'

// https://vite.dev/config/
// 与后端 `PORT` 对齐：`npm run dev` 子进程不会执行 `loadProjectEnvFile`，需从 .env 读入
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), '')
  const port = process.env.PORT || fileEnv.PORT || '3333'
  const devApiOrigin = `http://localhost:${port}`

  return {
  build: { copyPublicDir: false },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'public-root-assets',
      apply: 'build',
      async generateBundle() {
        // Gallery media lives in subdirectories and is served by the protected API.
        const publicDir = path.resolve(__dirname, 'public')
        for (const entry of await readdir(publicDir, { withFileTypes: true })) {
          if (!entry.isFile() || entry.name.startsWith('.')) continue
          this.emitFile({
            type: 'asset',
            fileName: entry.name,
            source: await readFile(path.join(publicDir, entry.name)),
          })
        }
      },
    },
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: { enabled: true },
      manifest: {
        name: 'Banana Gallery',
        short_name: 'Gallery',
        description: '本地 AI 图片画廊',
        theme_color: '#0a0a10',
        background_color: '#0a0a10',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/cdn-cgi(?:\/|$)/],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.git/**', '**/.provider-config.json*', '**/.vertex-service-account.json*'],
    },
    watch: {
      ignored: [
        '**/public/images', '**/public/images/**',
        '**/public/references', '**/public/references/**',
        '**/cache', '**/cache/**',
        '**/backups', '**/backups/**',
        '**/.provider-config.json*', '**/.vertex-service-account.json*',
        '**/gallery-data.json*', '**/generation-tasks.json*', '**/.pending-reference-uploads.json*',
      ],
    },
    proxy: {
      '/api': devApiOrigin,
      '/images': devApiOrigin,
      '/references': devApiOrigin,
    },
  },
  }
})
