import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'frontend',
  plugins: [react()],
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Excalidraw's font subsetting worker looks for these files by their
        // original (unhashed) names. Preserve them so the 404 doesn't break export.
        chunkFileNames: (chunkInfo) => {
          if (chunkInfo.name.startsWith('subset-')) {
            return 'assets/[name].js'
          }
          return 'assets/[name]-[hash].js'
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      // `EXCALIDRAW_ASSET_PATH` in `frontend/index.html` sends the canvas fonts here, and in
      // dev this server owns `/assets`. Only the fonts go across: everything else under
      // `/assets` in dev is Vite's own, and the canvas server has never heard of it.
      '/assets/fonts': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
})
