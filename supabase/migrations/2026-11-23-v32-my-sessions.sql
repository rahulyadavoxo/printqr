-- PrintQR v32 (2026-11-23): "Logged-in devices" in Settings. A shop owner or staff login can see where
-- their account is signed in (device, when last used, a masked IP) and log out one device.
-- "Log out all other devices" uses Supabase Auth itself (signOut scope 'others'), not this file.
-- Ending a session deletes its row in auth.sessions (its refresh tokens go with it), so that device
-- cannot refresh again; its current access token still works until it expires (about an hour at most).
-- Safe to run more than once.

-- Signed-in devices of the caller, newest first. is_current = the session this request comes from.
create or replace function public.my_sessions()
returns table (id uuid, created_at timestamptz, last_active timestamptz, user_agent text, ip text, is_current boolean)
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_uid uuid := auth.uid();
  v_sid text := nullif(auth.jwt() ->> 'session_id', '');
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  return query
    select s.id,
           s.created_at,
           coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at) as last_active,
           left(coalesce(s.user_agent, ''), 300) as user_agent,
           case
             when s.ip is null then null
             when family(s.ip) = 4 then split_part(host(s.ip), '.', 1) || '.' || split_part(host(s.ip), '.', 2) || '.x.x'
             else split_part(host(s.ip), ':', 1) || ':' || split_part(host(s.ip), ':', 2) || ':x:x'
           end as ip,
           (v_sid is not null and s.id::text = v_sid) as is_current
    from auth.sessions s
    where s.user_id = v_uid
      and (s.not_after is null or s.not_after > now())
    order by (v_sid is not null and s.id::text = v_sid) desc, 3 desc
    limit 50;
end $$;
revoke all on function public.my_sessions() from public, anon;
grant execute on function public.my_sessions() to authenticated;

-- Log out one of the caller's other devices. The current session is refused (the app logs out normally).
-- Returns false when that session is already gone.
create or replace function public.end_my_session(p_id uuid)
returns boolean language plpgsql volatile security definer set search_path = public, auth as $$
declare
  v_uid uuid := auth.uid();
  v_sid text := nullif(auth.jwt() ->> 'session_id', '');
  v_n int;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if p_id is null then return false; end if;
  if v_sid is not null and p_id::text = v_sid then raise exception 'use log out for this device'; end if;
  delete from auth.sessions s where s.id = p_id and s.user_id = v_uid;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function public.end_my_session(uuid) from public, anon;
grant execute on function public.end_my_session(uuid) to authenticated;
