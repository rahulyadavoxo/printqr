-- PrintQR v31 (2026-11-23): 2-step login (TOTP, Supabase Auth MFA) for the admin panel (audit S7).
--
-- What changes:
--  * is_admin() is now true only when the caller is in public.admins AND the login is aal2
--    (auth.jwt()->>'aal' = 'aal2', i.e. the 6-digit authenticator code was entered in this session).
--    Every admin_* function already starts with `if not public.is_admin() then raise exception 'not allowed'`,
--    so all of them require aal2 without being rewritten. The admin-action Edge Function checks the same.
--  * admin_status(): tells the app "is this login an admin at all" (without the aal check), whether 2-step is
--    required, and the current aal. The Dashboard drawer link and the /admin page use it to show the
--    "Set up 2-step login" / "Enter code" screen instead of "Not allowed".
--  * app_settings.admin_mfa_required (default TRUE). admin_set_settings() does not touch it, so only the
--    SQL editor can change it.
--
-- Before the first visit: Supabase Dashboard -> Authentication -> Multi-Factor (MFA) -> TOTP (App Authenticator)
-- must be enabled. Then open #/admin, scan the QR code with Google Authenticator / Authy / Microsoft Authenticator
-- and type the 6-digit code once. Every later admin login asks only for the code.
--
-- EMERGENCY (lost phone, TOTP turned off by mistake, locked out): in Supabase -> SQL Editor run
--     update public.app_settings set admin_mfa_required = false where id = 1;
-- Admin access then works with the normal login only (the app skips the code screen too).
-- To start over with a new phone: Authentication -> Users -> your user -> remove the MFA factor, then enrol again.
-- Turn it back on afterwards:
--     update public.app_settings set admin_mfa_required = true where id = 1;
--
-- Safe to run more than once.

alter table public.app_settings add column if not exists admin_mfa_required boolean not null default true;

create or replace function public.admin_mfa_required()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select s.admin_mfa_required from public.app_settings s where s.id = 1), true);
$$;
revoke all on function public.admin_mfa_required() from public, anon;
grant execute on function public.admin_mfa_required() to authenticated, service_role;

-- The check used by every admin_* function.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid())
    and (not public.admin_mfa_required() or coalesce(auth.jwt()->>'aal', '') = 'aal2');
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- For the app only (shows the admin link / the 2-step screens). It grants nothing: data still needs is_admin().
create or replace function public.admin_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'admin', exists (select 1 from public.admins a where a.user_id = auth.uid()),
    'mfa_required', public.admin_mfa_required(),
    'aal', coalesce(auth.jwt()->>'aal', 'aal1'));
$$;
revoke all on function public.admin_status() from public, anon;
grant execute on function public.admin_status() to authenticated;
