#!/usr/bin/env bash
# Opens (or updates) a GitHub issue labelled "alert" so the owner gets a GitHub notification (app / email).
#   scripts/gh-alert.sh open  "<title>" "<body>"   -> new issue, or a comment on the open one with the same title
#   scripts/gh-alert.sh close "<title>" "<body>"   -> closes the open issue with that title (problem fixed)
# Needs GH_TOKEN (the workflow's GITHUB_TOKEN with issues: write). The repo is public: never pass secrets
# or personal data in the title or body.
set -uo pipefail
mode="$1"; title="$2"; body="${3:-}"
gh label create alert --color B60205 --description "Automatic alert from a workflow" >/dev/null 2>&1 || true
num=$(gh issue list --label alert --state open --search "in:title \"$title\"" --json number,title \
  --jq ".[] | select(.title == \"$title\") | .number" | head -1)
if [ "$mode" = "open" ]; then
  if [ -n "$num" ]; then
    gh issue comment "$num" --body "Still happening ($(TZ=Asia/Kolkata date '+%d %b %H:%M IST')).

$body" >/dev/null
  else
    gh issue create --title "$title" --label alert --assignee "$GITHUB_REPOSITORY_OWNER" --body "$body" >/dev/null \
      || gh issue create --title "$title" --label alert --body "$body" >/dev/null
  fi
elif [ "$mode" = "close" ] && [ -n "$num" ]; then
  gh issue close "$num" --comment "Resolved ($(TZ=Asia/Kolkata date '+%d %b %H:%M IST')). ${body}" >/dev/null
fi
exit 0
