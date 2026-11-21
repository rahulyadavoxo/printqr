#!/usr/bin/env bash
# Fresh-install check: runs supabase/schema.sql (base + all migrations) on the local Supabase, then the newest
# migration twice more (it must be safe to run again).
set -euo pipefail
export PGPASSWORD=postgres
PSQL=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)
run() { echo "  $1"; "${PSQL[@]}" -f "$1" > /dev/null; }
# Old migrations are only safe to repeat on their own era's shape, so the repeat check runs the newest one
# (that is what the migrations workflow does: it runs only the new / changed file).
newest=$(cd supabase/migrations && for f in *.sql; do n=$(echo "$f" | grep -oE -- '-v[0-9]+' | head -1 | tr -dc '0-9'); echo "${n:-0} $f"; done | sort -n | tail -1 | awk '{print $2}')
echo "schema.sql (fresh install)"
run supabase/schema.sql
echo "Newest migration again (must be safe to repeat)"
run "supabase/migrations/$newest"
run "supabase/migrations/$newest"
echo "Fresh install OK"
