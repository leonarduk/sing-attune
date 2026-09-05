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
  // Emit "./assets/…" instead of the Vite default "/assets/…" in the built
  // HTML. The packaged Electron app loads dist/index.html via loadFile()
  // (a file:// origin — see frontend/electron/main.js and issue #436): a
  // root-absolute "/assets/x.js" resolves to file:///assets/x.js (dropped
  // from the filesystem root, no drive letter/dir prefix) and 404s, while a
  // relative "./assets/x.js" resolves against index.html's own directory
  // and loads correctly. Harmless for the Vite dev server and any
  // same-origin static host, which both still resolve "./" the same as "/".
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        // Developer/validation-only tenor overlay view (#360). A separate
        // HTML entry point — not linked from index.html — so it is only
        // reachable by navigating to it directly, never from the practice UI.
        debugTenorOverlay: resolve(__dirname, 'debug-tenor-overlay.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to FastAPI backend during development
      '/health': 'http://127.0.0.1:8000',
      '/score': 'http://127.0.0.1:8000',
      '/audio': 'http://127.0.0.1:8000',
      '/playback': 'http://127.0.0.1:8000',
                  '/transcribe': 'http://127.0.0.1:8000',
                  '/session': 'http://127.0.0.1:8000',
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
      },
    },
  },
})
