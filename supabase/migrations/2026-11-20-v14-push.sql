-- PrintQR v14 (2026-11-20): new-order push notifications for the Android app (Firebase Cloud Messaging).
-- Safe to run more than once. Needs v4 (pg_net + private.cron_tokens).
-- Flow: order becomes 'received' -> trigger -> pg_net calls Edge Function push-new-order -> FCM -> owner's phones.

create extension if not exists pg_net;

-- Phones that get notifications: one row per app install, tied to the shop owner's login.
create table if not exists public.push_tokens (
  token text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  platform text not null default 'android',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_tokens_owner on public.push_tokens (owner_id);
alter table public.push_tokens enable row level security;   -- no policies: only the functions below touch it
revoke all on public.push_tokens from public, anon, authenticated;

create or replace function public.register_push_token(p_token text, p_platform text default 'android')
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if p_token is null or length(p_token) < 20 or length(p_token) > 4096 then
    raise exception 'Bad push token' using errcode = '22023';
  end if;
  insert into public.push_tokens (token, owner_id, platform)
  values (p_token, auth.uid(), left(coalesce(nullif(p_platform, ''), 'android'), 20))
  on conflict (token) do update set owner_id = excluded.owner_id, platform = excluded.platform, updated_at = now();
  -- Keep the 10 newest phones per owner.
  delete from public.push_tokens
  where owner_id = auth.uid()
    and token not in (select token from public.push_tokens where owner_id = auth.uid() order by updated_at desc limit 10);
end $$;

create or replace function public.unregister_push_token(p_token text)
returns void language sql security definer set search_path = public as $$
  delete from public.push_tokens where token = p_token and owner_id = auth.uid();
$$;

revoke all on function public.register_push_token(text, text) from public, anon;
revoke all on function public.unregister_push_token(text) from public, anon;
grant execute on function public.register_push_token(text, text) to authenticated;
grant execute on function public.unregister_push_token(text) to authenticated;

-- Secret only the trigger and the Edge Function know.
insert into private.cron_tokens (name, token)
values ('push', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

-- The Edge Function removes dead phones with the service role.
create or replace function public.notify_new_order()
returns trigger language plpgsql security definer set search_path = public, private as $$
begin
  if new.status = 'received' and (tg_op = 'INSERT' or old.status = 'uploading') then
    if exists (select 1 from public.push_tokens p join public.shops s on s.owner_id = p.owner_id where s.id = new.shop_id) then
      perform net.http_post(
        url := 'https://asqgdgzxkdksoikmffmd.supabase.co/functions/v1/push-new-order',
        body := jsonb_build_object('order_id', new.id),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-token', (select token from private.cron_tokens where name = 'push')
        ),
        timeout_milliseconds := 10000
      );
    end if;
  end if;
  return new;
exception when others then
  return new;  -- a notification problem must never block an order
end $$;

drop trigger if exists orders_push_notify on public.orders;
create trigger orders_push_notify after insert or update of status on public.orders
  for each row execute function public.notify_new_order();

notify pgrst, 'reload schema';

-- Check (after a test order):
--   select id, status_code, content from net._http_response order by created desc limit 5;
