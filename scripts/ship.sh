#!/usr/bin/env bash
#
# scripts/ship.sh — verify, and (optionally) commit + push, in one command.
#
# WHY THIS EXISTS. Shipping this repo was the same hand-run sequence every time, and John
# was doing the copying. That is work a file can do. It also removes a real failure mode: a
# hand-run sequence can be interrupted halfway, leaving tests that passed and a push that
# never happened, with nothing recording which — this repo has already lost a day to a
# finished fix sitting uncommitted while the bug stayed live.
#
#   ./scripts/ship.sh              verify only — tests + workflow sanity. Writes nothing.
#   ./scripts/ship.sh --commit     verify, then stage everything, commit, and push.
#
# The commit message is read from .ship-msg in the repo root (gitignored). Claude writes
# that file; you run the script. It refuses to commit without one.
#
# ⚠ THERE IS NO BUILD STEP, DELIBERATELY. This repo has no dependencies and no bundler —
# see README. `npm ci` is not run for the same reason: a monitor that a supply-chain update
# can break is a monitor that will be broken on the morning you need it.
#
# ⚠ A PUSH PUBLISHES NOTHING HERE. Unlike the website repos, nothing deploys. The workflows
# pick the new code up on their next run, which — since GitHub's scheduler degraded on
# 2026-08-26 — may be HOURS away. Use the dispatch line this script prints at the end if
# you want to exercise the change now.
#
# ⚠ `set -e` IS correct here and is not always. A script whose job is to run a command that
# SHOULD fail must never use it. This script's job is the opposite: stop at the first thing
# that goes wrong, before anything is pushed.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
MSG_FILE="$ROOT/.ship-msg"
COMMIT=0
[ "${1:-}" = "--commit" ] && COMMIT=1

hr() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
ok() { printf '   \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '   \033[33m⚠\033[0m %s\n' "$1"; }
die() { printf '\n\033[31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }

hr "Stale lock"
# ⚠ A CLOUD SESSION LEAVES A .git/index.lock IT CANNOT DELETE, AND IT BLOCKS THE NEXT
# COMMIT ON THIS MACHINE. Any git command Claude runs on a mounted repo can create one;
# the container owns the file and `rm` there returns "Operation not permitted". The
# symptom is a commit failing with "Unable to create index.lock: File exists", which reads
# like a concurrent git process and usually is not.
#
# ⚠ NOT AUTO-DELETED, DELIBERATELY. If a real git process IS holding that lock, removing
# it corrupts the index. Detect, explain, and let a human decide.
if [ -e .git/index.lock ]; then
  printf '   \033[31m✗\033[0m .git/index.lock exists (age: %s)\n' "$(date -r .git/index.lock '+%Y-%m-%d %H:%M' 2>/dev/null || echo unknown)"
  printf '\n   If no git process is running here, it is stale — almost always left by a\n'
  printf '   cloud session. Remove it and re-run:\n\n'
  printf '     rm -f "%s/.git/index.lock"\n\n' "$ROOT"
  die "Refusing to continue with a lock in place."
fi
ok "no stale index.lock"

hr "Working tree"
git status -s || true
if [ "$COMMIT" = "1" ] && [ -z "$(git status --porcelain)" ]; then
  die "Nothing to commit. Working tree is clean."
fi

hr "Tests"
# ⚠ --test-reporter=tap is FORCED, and the EXIT CODE is what gets checked. This Mac runs
# node v24, which prints `ℹ tests`; the container that writes these tests runs v22 and
# prints `# tests`. Grepping for one on the other returns SILENCE, and silence reads
# exactly like a pass. That has happened here for real. The exit code does not change
# between versions, which is why it is the thing trusted.
node --test --test-reporter=tap > /tmp/monitors-tests.log 2>&1 || {
  grep -E '^not ok|^# fail' /tmp/monitors-tests.log | head -20
  die "Suite failed. Full log: /tmp/monitors-tests.log — nothing was staged."
}
ok "$(grep -E '^# pass' /tmp/monitors-tests.log | head -1) · $(grep -E '^# fail' /tmp/monitors-tests.log | head -1)"

hr "Syntax"
for f in probe.mjs checks.mjs; do
  node --check "$f" || die "$f does not parse — nothing was staged."
done
# ⚠ `node --check` proves the file PARSES and nothing more. A ReferenceError is a runtime
# event and passes this cleanly — that exact gap shipped a bare LIVE_ORIGIN that did not
# exist in probe.mjs on 2026-08-24. The tests above are the real proof; this only catches
# the class the tests cannot reach, because a syntax error stops them loading at all.
ok "probe.mjs and checks.mjs parse"

hr "Workflow sanity"
# Not a YAML parser — a check for the two ways these files have actually been broken:
# a tab (YAML forbids them, and the error is unhelpful), and a lost top-level key.
for f in .github/workflows/*.yml; do
  grep -qP '\t' "$f" && die "$f contains a TAB — YAML forbids it and the parser error will not say so."
  for key in name on jobs; do
    grep -qE "^${key}:" "$f" || die "$f has lost its top-level '${key}:' key."
  done
done
ok "$(ls .github/workflows/*.yml | wc -l | tr -d ' ') workflow files have name/on/jobs and no tabs"

hr "Secrets these workflows expect"
# ⚠ THIS SCRIPT CANNOT VERIFY THAT ANY OF THESE EXIST — that needs an authenticated call.
# It lists them so a NEW one cannot be introduced silently. A missing dead-man URL is a
# hard failure by design (exit 3), so an unlisted-but-required secret turns every run of
# that suite red until somebody notices.
grep -ohE 'secrets\.[A-Z_]+' .github/workflows/*.yml | sed 's/secrets\.//' | sort -u | sed 's/^/     /'
warn "Confirm each exists: Settings → Secrets and variables → Actions."
warn "DEADMAN_URL_DAILY is REQUIRED since probe-daily gained --deadman. Without it that suite exits 3."

if [ "$COMMIT" != "1" ]; then
  hr "Verified"
  printf '   Nothing was written. Run with --commit to ship.\n\n'
  exit 0
fi

hr "Commit message"
[ -s "$MSG_FILE" ] || die "No .ship-msg in the repo root, or it is empty. Refusing to commit."
head -1 "$MSG_FILE"
printf '   (%s lines)\n' "$(wc -l < "$MSG_FILE" | tr -d ' ')"

hr "Staging"
git add -A
git status -s
# `git add -A` is safe here because .gitignore covers node_modules, *.log, .DS_Store and
# .ship-msg, and this repo has no .env of any kind — checked 2026-08-31. That is a fact
# about THIS repo on THAT date, not a general licence. If a secret file ever lands here,
# this is the line to revisit.

hr "Committing"
git commit -F "$MSG_FILE" --quiet
SHA="$(git log -1 --format='%h')"
ok "$SHA $(git log -1 --format='%s')"

hr "Pushing"
git push --quiet
if [ -n "$(git status -sb | head -1 | grep -o 'ahead [0-9]*' || true)" ]; then
  die "Push reported success but the branch is still ahead. Check the remote."
fi
ok "pushed · $(git status -sb | head -1)"

hr "Done"
printf '   %s is on main. NOTHING IS DEPLOYED — this repo has no deploy.\n' "$SHA"
printf '   The suites pick it up on their next run, which may be HOURS away while\n'
printf '   GitHub'"'"'s scheduler is degraded. To exercise it now:\n\n'
printf '     Actions → Probe · fast → Run workflow\n\n'
printf '   ⚠ test.yml runs on this push and is the first thing to exercise\n'
printf '     actions/checkout@v7 and actions/setup-node@v7. If it goes red, that\n'
printf '     bump is the suspect — it was never run before being pushed.\n\n'
