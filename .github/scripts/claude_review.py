"""
AI code review script — called by pr-review.yml.

Reads PR_TITLE, DIFF, ISSUE_BODY from environment variables,
calls the Claude API, and prints the review to stdout.
The workflow captures stdout and posts it as a PR comment.
"""

import json
import os
import sys
import urllib.request

api_key = os.environ.get("ANTHROPIC_API_KEY", "")
if not api_key:
    print("ERROR: ANTHROPIC_API_KEY not set", file=sys.stderr)
    sys.exit(1)

pr_title = os.environ.get("PR_TITLE", "")
diff = os.environ.get("DIFF", "")
issue_body = os.environ.get("ISSUE_BODY", "No linked issue found. Review code on its own merits.")

prompt = f"""You are a senior engineer reviewing a pull request for **sing-attune**, \
a real-time choir practice app.

The stack is Python/FastAPI backend + Vite+TypeScript frontend + Electron (future).
Key constraints: audio latency <80ms end-to-end, thread-safe pitch pipeline, \
asyncio event loop correctness.

## Linked issue / acceptance criteria
{issue_body}

## PR title
{pr_title}

## Diff (Python, TypeScript, Markdown, config files — truncated at 30k chars)
{diff}

If the diff is empty, this is likely a docs-only or config-only PR whose file types \
were not captured. In that case, review the PR based solely on the linked issue \
acceptance criteria and PR title, and note that no diff was available.

Review this PR across these dimensions. Be direct and specific — cite line numbers \
or function names where relevant. If something looks fine, say so briefly. \
Spend your words on real concerns.

### 1. Acceptance criteria
Does the diff satisfy every AC in the linked issue? Call out any gaps explicitly. \
If no diff is available, assess whether the PR title and issue description suggest \
the work is complete and correctly scoped.

### 2. Bugs and logic errors
Any incorrect behaviour, edge cases that aren't handled, or off-by-one errors? \
For documentation PRs: are there factual errors, contradictions, or dangerously \
misleading statements?

### 3. Thread safety and async correctness
(Backend code only — skip for docs/frontend-only PRs)
- Are shared mutable objects properly locked?
- Is call_soon_threadsafe used correctly?
- Any asyncio anti-patterns (blocking calls in coroutines, wrong loop assumptions)?

### 4. Test coverage
Are the acceptance criteria actually exercised by tests? Any obvious missing cases? \
Not applicable for documentation-only PRs.

### 5. Minor issues (optional)
Style, naming, docstrings — only flag if they would cause future confusion.

End with a one-line summary verdict: **APPROVE**, **REQUEST CHANGES**, \
or **COMMENT** (no blocking concerns but worth noting).
"""

payload = {
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1500,
    "messages": [{"role": "user", "content": prompt}],
}

req = urllib.request.Request(
    "https://api.anthropic.com/v1/messages",
    data=json.dumps(payload).encode(),
    headers={
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f"ERROR: Claude API returned {e.code}: {body}", file=sys.stderr)
    sys.exit(1)

review = data["content"][0]["text"]
print(review)
