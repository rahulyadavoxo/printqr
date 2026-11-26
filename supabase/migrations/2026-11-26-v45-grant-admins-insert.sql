-- PrintQR v45 migration (2026-11-26): admin-action "Make Support" inserts into public.admins with the
-- service role, which only had SELECT (v20, v30). Without INSERT it fails with
-- "DB 403: 42501 permission denied for table admins". Safe to run more than once (GRANT is idempotent).
-- Already applied by hand in production on 2026-11-26.
grant insert on public.admins to service_role;
