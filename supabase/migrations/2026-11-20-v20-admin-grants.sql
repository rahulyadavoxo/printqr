-- v20: let Edge Functions (service_role) read the admin list and write the admin log.
-- Without this, admin-action fails with "DB 403 ... 42501" (permission denied for table admins),
-- so "Send password reset", disable/enable user etc. show "Something went wrong".
-- Safe to run more than once.
grant select on public.admins to service_role;
grant select, insert on public.admin_log to service_role;
