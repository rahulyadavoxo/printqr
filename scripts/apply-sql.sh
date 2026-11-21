#!/usr/bin/env bash
# Fresh-install check: runs supabase/schema.sql (base + all migrations) and then every migration again in version order
# on the local Supabase, twice, because every migration must be safe to run more than once
# (the "Run Supabase SQL migrations" workflow relies on that).
set -euo pipefail
export PGPASSWORD=postgres
PSQL=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)
run() { echo "  $1"; "${PSQL[@]}" -f "$1" > /dev/null; }
files=$(cd supabase/migrations && for f in *.sql; do n=$(echo "$f" | grep -oE -- '-v[0-9]+' | head -1 | tr -dc '0-9'); echo "${n:-0} $f"; done | sort -n | awk '{print $2}')
echo "schema.sql"
run supabase/schema.sql
for pass in 1; do
  echo "Migrations, pass $pass"
  for f in $files; do run "supabase/migrations/$f"; done
done
echo "Fresh install OK"
