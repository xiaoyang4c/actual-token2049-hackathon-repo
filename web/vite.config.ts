import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import {defineConfig} from 'vite'

// The control API (bun run services) serves /reliability/*. TALLY_API_URL points elsewhere.
const engine = {target: process.env.TALLY_API_URL ?? 'http://127.0.0.1:8787', changeOrigin: true}
// Ask a Coworker: the worker's ask server (COWORKER_ASK_PORT) serves /ask; ui/server.ts maps /coworkers/ask to it.
const ask = {target: process.env.COWORKER_ASK_URL ?? 'http://127.0.0.1:8792', changeOrigin: true, rewrite: (p: string) => p.replace(/^\/coworkers\/ask/, '/ask')}
const evidence = {target: process.env.CHAINLINK_EVIDENCE_URL ?? 'http://127.0.0.1:8793', changeOrigin: true}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {alias: {'@': path.resolve(__dirname, './src')}},
  build: {rolldownOptions: {input: {main: path.resolve(__dirname, 'index.html'), evidence: path.resolve(__dirname, 'evidence-standalone.html')}}},
  server: {port: 5190, proxy: {'/reliability/evidence': evidence, '/reliability': engine, '/coworkers/ask': ask}},
})
