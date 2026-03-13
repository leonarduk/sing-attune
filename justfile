# sing-attune — just recipes (https://github.com/casey/just)
# Install: winget install Casey.Just
#
# Usage:
#   just dev-backend    start FastAPI with reload
#   just dev-frontend   start Vite dev server
#   just install        install all dependencies
#   just test           run backend tests

backend-dir := "backend"
frontend-dir := "frontend"

# Use PowerShell when running recipes on Windows so `just` doesn't depend on `sh`.
set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

# Install all dependencies
install:
    uv sync
    cd {{frontend-dir}} && npm install

# Start FastAPI backend (reload on change)
dev-backend:
    uv run uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload

# Start Vite frontend dev server
dev-frontend:
    cd {{frontend-dir}} && npm run dev

# Run backend tests
test:
    uv run pytest backend/tests -v

# Build frontend for production
build-frontend:
    cd {{frontend-dir}} && npm run build
