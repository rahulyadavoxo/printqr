-- PrintQR v46 migration (2026-11-27): admin-action "Remove admin" (bug #49) deletes a row from public.admins
-- with the service role, which only had SELECT (v20, v30) and INSERT (v45). Without DELETE it would fail with
-- "DB 403: 42501 permission denied for table admins". Safe to run more than once (GRANT is idempotent).
grant delete on public.admins to service_role;
