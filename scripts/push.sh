#!/usr/bin/env bash
# scripts/push.sh — push from a Cowork session's device VM, which has no git credential.
#
# ⚠ WHY THIS EXISTS. Every commit made from a Cowork session has had to wait for John to
# open a terminal, because the VM `device_bash` runs in mounts only the connected folders:
# no macOS keychain, no ~/.ssh, no `gh` auth. `git push` there dies with
# `could not read Username for 'https://github.com'`. The credential is reachable — it sits
# in the Dropbox tokens file the rest of the automation already reads — it was just never
# wired to git.
#
# ⚠⚠ AND IT FAILS LOUD ON A DEAD TOKEN, DELIBERATELY. On 2026-09-10 `GITHUB_TOKEN` in that
# file was expired (`GET /user` → 401 Bad credentials) and git's own error said only
# "Invalid username or token", which reads like a wiring mistake and sent me looking at the
# helper instead of the credential. The preflight below names which of the two is wrong
# BEFORE the push runs. [[silent-fallbacks-are-the-bug]]
#
# Usage:  bash scripts/push.sh [remote] [branch]     (defaults: origin main)
set -euo pipefail

REMOTE="${1:-origin}"
BRANCH="${2:-main}"
# ⚠ The same file has two paths depending on WHERE this runs: a Cowork session sees the
# connected folder mounted under $HOME/mnt/, John's own terminal sees ~/Dropbox/. Try both
# rather than hard-coding the one that happened to be true when this was written.
TOKENS="${STANDPOINT_TOKENS:-}"
if [ -z "$TOKENS" ]; then
  for c in "$HOME/mnt/johnelbing--Dropbox--Elbing & co--Standpoint--PROJECTS/AutomationTokens.txt" \
           "$HOME/Dropbox/Elbing & co/Standpoint/PROJECTS/AutomationTokens.txt" \
           "$HOME/Library/CloudStorage/Dropbox/Elbing & co/Standpoint/PROJECTS/AutomationTokens.txt"; do
    [ -f "$c" ] && { TOKENS="$c"; break; }
  done
fi
[ -n "$TOKENS" ] && [ -f "$TOKENS" ] || { echo "push: AutomationTokens.txt not found in any known location — set STANDPOINT_TOKENS" >&2; exit 2; }

GT="$(grep -m1 '^GITHUB_TOKEN=' "$TOKENS" | cut -d= -f2- | tr -d '\r\n')"
[ -n "$GT" ] || { echo "push: no GITHUB_TOKEN= line in the tokens file" >&2; exit 2; }
export GT

# Preflight: is the TOKEN dead, or is the wiring wrong? Answer that before pushing.
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $GT" https://api.github.com/user || echo 000)"
case "$code" in
  200) ;;
  401) echo "push: GITHUB_TOKEN is expired or revoked (GitHub says 401). Generate a new fine-grained PAT with Contents: read & write on this repo and replace the GITHUB_TOKEN= line in the tokens file. The wiring is fine." >&2; exit 3;;
  000) echo "push: could not reach api.github.com from this VM — network, not credentials." >&2; exit 4;;
  *)   echo "push: unexpected $code from api.github.com — do not assume the token is fine." >&2; exit 5;;
esac

# ⚠ A repo mounted into a Cowork session refuses unlink, so git strands its own lock files
# and the NEXT git command dies on a stale lock. Rename them away (rename IS permitted).
# ⚠ The quarantine lives inside .git/ deliberately: same filesystem (so rename works, a
# cross-device mv would be a copy+unlink and unlink is the thing that is refused) and never
# tracked, whatever this repo's .gitignore happens to say.
LOCKS="$(git rev-parse --git-dir)/_stranded-locks"; mkdir -p "$LOCKS"
find "$(git rev-parse --git-dir)" -maxdepth 3 -name '*.lock' -exec mv {} "$LOCKS/" \; 2>/dev/null || true

# ⚠ The token is never echoed, and any accidental appearance in git's output is filtered.
git -c credential.helper='!f(){ echo username=x; echo "password=$GT"; };f' \
    push "$REMOTE" "$BRANCH" 2>&1 | sed "s/$GT/<token>/g"
