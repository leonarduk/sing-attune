import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to FastAPI backend during development
      '/health': 'http://127.0.0.1:8000',
      '/score': 'http://127.0.0.1:8000',
      '/audio': 'http://127.0.0.1:8000',
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
      },
    },
  },
})
