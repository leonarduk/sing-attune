/**
 * VoiceTrace frontend entry point.
 * Day 1: health check only. Score + pitch overlay added Day 8/9.
 */

const statusEl = document.getElementById('status')!

async function checkBackend(): Promise<void> {
  try {
    const res = await fetch('/health')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    statusEl.textContent = `backend ok (v${data.version})`
    statusEl.className = 'ok'
  } catch (err) {
    statusEl.textContent = 'backend unreachable'
    statusEl.className = 'error'
    console.error('Backend health check failed:', err)
  }
}

checkBackend()
