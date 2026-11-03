#!/usr/bin/env bash
set -Eeuo pipefail

# Reproducible, non-destructive bootstrap for Claude Code/Linux.
# Human third-party accounts and secrets are NOT created here.
# Milestone 01 populates package.json, package-lock.json and runnable npm scripts.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

printf '[setup] repository: %s\n' "$REPO_ROOT"
for cmd in git node npm bash; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf '[setup] ERROR: required command missing: %s\n' "$cmd" >&2
    exit 1
  fi
done
printf '[setup] node=%s npm=%s git=%s\n' "$(node --version)" "$(npm --version)" "$(git --version)"

if [[ -f package.json ]]; then
  if [[ ! -f package-lock.json ]]; then
    printf '[setup] ERROR: package.json exists but package-lock.json missing; Milestone 01 must generate and commit lockfile.\n' >&2
    exit 1
  fi
  echo '[setup] installing exact locked npm dependencies via npm ci'
  npm ci --no-audit --no-fund
else
  printf '[setup] No package.json yet: spec-only repository. Milestone 01 must create app, package.json and package-lock.json.\n'
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo '[setup] Docker is available; Supabase local validation may run.'
else
  echo '[setup] Docker unavailable. This is NOT a passing database test; GitHub Actions ubuntu runner must run Supabase migrations and pgTAP.'
fi

if command -v supabase >/dev/null 2>&1; then
  printf '[setup] Supabase CLI installed: '; supabase --version
else
  echo '[setup] Supabase CLI not available locally; required database checks will execute in GitHub Actions after Milestone 01.'
fi

echo '[setup] No accounts, licenses, or secrets created. See docs/setup/HUMAN_CHECKLIST.md.'
