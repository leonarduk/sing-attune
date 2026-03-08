#!/usr/bin/env bash
# scripts/install-hooks.sh
# One-time setup: installs git hooks for this repo.
# Run once after cloning: bash scripts/install-hooks.sh

set -e
REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK="$REPO_ROOT/.git/hooks/pre-commit"

cat > "$HOOK" << 'EOF'
#!/usr/bin/env bash
# pre-commit: run ruff on staged backend Python files
set -e

STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep '^backend/.*\.py$' || true)
if [ -z "$STAGED" ]; then
    exit 0
fi

echo ">>> ruff check backend/ ..."
uv run ruff check backend/
echo ">>> ruff OK"
EOF

chmod +x "$HOOK"
echo "✅  pre-commit hook installed → $HOOK"
