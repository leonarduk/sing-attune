# sing-attune — Agent Development Guide

> See also: `CLAUDE.md`.
> Keep this file and `CLAUDE.md` in sync whenever either one changes.

## Branching

- **Never commit directly to `main`**
- One branch per issue: `feature/dayN-short-description`
- **Always create the branch from the GitHub issue** using `gh issue develop`:
  ```
  gh issue develop <N> --checkout --branch feature/dayN-short-description
  ```
  This links the branch to the issue on GitHub automatically.
- If `gh` is unavailable, create manually then link explicitly:
  ```
  git checkout -b feature/dayN-short-description
  # and reference the issue in every commit (see below)
  ```
- At end of day: push branch, open PR, merge via GitHub

## Commit messages

- Format: `type: short description`
- **Every commit must reference the issue number** — use `Refs #N` for intermediate commits, `Closes #N` for the final commit:
  ```
  # Intermediate commit:
  feat: add pitch frame queue

  Refs #8

  # Final commit (closes the issue on PR merge):
  feat: Day 8 — frontend sync protocol

  Closes #8
  ```
- `Closes #N` goes in the **body**, not the subject line
- PR descriptions must also include `Closes #N` for the linked issue (e.g. `Closes #179`) so merge auto-closes it
- Do not leave any commit without an issue reference — it makes history untraceable
- Types: `feat`, `fix`, `test`, `chore`, `refactor`, `docs`

## Workflow per issue

1. Review the GitHub issue — check for stale assumptions before writing code
2. Create feature branch on GitHub — never work without a branch
3. For every file to be changed: **fetch from the branch first** — never reconstruct from memory, diff, or a prior commit
4. Write changes and push to the branch — verify the returned SHA confirms success
5. Run linter — fix all violations before committing
6. Read the source of every function being mocked in tests — verify the mock has the correct constructor signature before pushing
7. Update README.md status table if any component status has changed
8. Open PR — **stop here and wait for user confirmation before merging**
9. User merges PR → issue auto-closes

## Rules agents must never break

- **Never merge a PR** — agents push fixes and report status. Merging is always the user's decision, even when all gates are green.
- **Never edit local files as a substitute for pushing to GitHub** — local edits that are not pushed accomplish nothing. All work goes through the GitHub API.
- **Always fetch the current file from the branch before editing** — use the appropriate API call with the head branch ref. Never reconstruct a file from memory, diff context, or a prior commit SHA.
- **Always verify a push succeeded** — check the returned SHA. Do not report work as done until the push is confirmed.
- **Never start a coding task without a branch** — creating a branch and then leaving it at main's content is the same as not creating it.
- **Before writing test mocks: read the real class being mocked** — check its `__init__` signature and any methods called on it during the code path under test. A mock with the wrong signature will cause CI to fail with `TypeError`.
- **Never report "done" while CI is still running or failing** — wait for CI to complete and triage any failures before closing the loop with the user.

## Before every commit

```powershell
# 1. Fix all lint violations (auto-fixes unused imports etc.)
uv run ruff check backend/ --fix

# 2. Verify clean
uv run ruff check backend/

# 3. Run all tests
uv run pytest -v
```

All three must pass. No exceptions.

## Testing

```powershell
# All tests (hardware tests run locally, auto-skipped in CI)
uv run pytest -v

# Single file
uv run pytest backend/tests/test_pipeline.py -v

# Hardware tests only (requires real mic/audio devices)
uv run pytest -m hardware -v

# GPU tests only run when CUDA is available (auto-skipped otherwise)
```

### Hardware marker

Tests that require real audio devices are marked `@pytest.mark.hardware`.
They run locally (where devices exist) and are **automatically skipped in CI**
(`GITHUB_ACTIONS` env var is set by GitHub Actions).

Do NOT remove hardware marks to make CI pass — fix the underlying issue instead.

### CI environment constraints

CI has no audio hardware. Any test that directly or indirectly constructs `MicCapture`
(or calls `sounddevice` in any form) will fail in CI unless:
- The test is marked `@pytest.mark.hardware`, OR
- The test monkeypatches `MicCapture` (and `PitchPipeline`) in `backend.audio.pipeline`
  before the code under test runs.

When writing tests for code paths that rebuild hardware objects (e.g. `set_force_cpu`),
always patch both `MicCapture` and `PitchPipeline` at the module level where they are
imported, not at the class definition level.

## What ruff catches

ruff is a fast Python linter (written in Rust). It replaces flake8 + isort.
Common violations it catches in this codebase:
- `F401` — unused imports (auto-fixable with `--fix`)
- `F841` — local variable assigned but never used
- `E501` — line too long
- `I001` — import ordering

Run `uv run ruff check backend/ --fix` before committing — it auto-fixes
most violations. If any remain after `--fix`, fix them manually.

## CI (GitHub Actions)

Every PR runs `.github/workflows/pr-review.yml`:

| Job | What it does |
|-----|-------------|
| `lint` | `ruff check backend/` — fails on any violation |
| `test` | `pytest` with CPU torch + libportaudio2 — hardware tests auto-skipped |
| `ai-review` | Calls AI API, posts review comment against linked issue ACs |

The AI review is advisory. `lint` and `test` are blocking.

## Python environment

```powershell
# Install core deps (includes ruff as a dev dependency)
uv sync

# Install PyTorch (CUDA 12.8 — compatible with CUDA 12.9 runtime)
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128

# Install torchcrepe (pitch engine)
uv pip install torchcrepe
```

## Running the backend

```powershell
just dev-backend
# or
uv run uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

## Key architecture decisions

| Decision | Choice | Reason |
|---|---|---|
| Pitch engine (GPU) | torchcrepe | PyTorch-based, CUDA-friendly, actively maintained |
| Pitch engine (CPU) | librosa pYIN | Ships with torchcrepe, no C build deps |
| torchcrepe decoder | `weighted_argmax` | Avoids scipy.signal (blocked by App Control policy) |
| Audio fallback | Not aubio | No Windows wheels, requires pkg-config + C toolchain |
| Score rendering | OSMD (Day 8+) | Best MusicXML support in browser |
| Audio playback | Web Audio API (Day 9+) | Browser-native, real-time tempo control |
| Clock source | `AudioContext.currentTime` | Never use `Date.now()` for sync |

## Device notes (this machine)

- GPU: NVIDIA RTX 5070, CUDA 12.9
- Default mic: device 1 — Microphone Array (Realtek, MME)
- Preferred mic: device 9 — Microphone Array (Realtek, WASAPI) — lower latency
- Jabra Evolve2 85 (devices 24/25): Bluetooth — ~100-200ms latency, avoid for pitch tracking
