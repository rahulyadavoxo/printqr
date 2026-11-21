#!/usr/bin/env bash
# Starts a throw-away local Supabase (Postgres + Auth + Storage + REST) in Docker for CI checks.
# Uses its own empty folder, so this repo's migrations are NOT applied automatically.
# Afterwards: PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres
set -euo pipefail
dir="${RUNNER_TEMP:-/tmp}/sb-local"
rm -rf "$dir" && mkdir -p "$dir" && cd "$dir"
supabase init --force >/dev/null
supabase start -x studio,imgproxy,inbucket,mailpit,edge-runtime,logflare,vector,realtime,postgres-meta,supavisor >/dev/null
echo "Local Supabase is up"
