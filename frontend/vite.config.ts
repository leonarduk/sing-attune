import { createReadStream, existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'

const museScoreRoot = resolve(__dirname, '../musescore')

function devMusescorePlugin(): Plugin {
  return {
    name: 'dev-musescore-static',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/musescore', (req, res, next) => {
        const rawPath = req.url?.split('?')[0] ?? '/'
        const relativePath = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath
        const fullPath = resolve(museScoreRoot, relativePath)

        if (!fullPath.startsWith(`${museScoreRoot}${sep}`)) {
          res.statusCode = 403
          res.end('Forbidden')
          return
        }

        if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
          return next()
        }

        res.setHeader('Content-Type', 'application/vnd.recordare.musicxml+xml')
        createReadStream(fullPath).pipe(res)
      })
    },
  }
}

export default defineConfig({
  plugins: [devMusescorePlugin()],
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to FastAPI backend during development
      '/health': 'http://127.0.0.1:8000',
      '/score': 'http://127.0.0.1:8000',
      '/audio': 'http://127.0.0.1:8000',
      '/playback': 'http://127.0.0.1:8000',
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
      },
    },
  },
})
