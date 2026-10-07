import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import {defineConfig} from 'vite'

// The control API (bun run services) serves /reliability/*. TALLY_API_URL points elsewhere.
const engine = {target: process.env.TALLY_API_URL ?? 'http://127.0.0.1:8787', changeOrigin: true}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {alias: {'@': path.resolve(__dirname, './src')}},
  server: {port: 5190, proxy: {'/reliability': engine, '/studio': engine}},
})
