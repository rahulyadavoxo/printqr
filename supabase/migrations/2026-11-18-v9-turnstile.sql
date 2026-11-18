-- PrintQR v9 migration (2026-11-18): Cloudflare Turnstile bot check on customer uploads.
-- RUN THIS ONLY AFTER the TURNSTILE_SECRET Edge Function secret is saved in Supabase.
-- After this, an order can be created only with a one-time pass from the upload-pass Edge Function,
-- which gives one only after Cloudflare confirms the Turnstile check.
-- Safe to run more than once. Paste the whole file in Supabase -> SQL Editor -> New query -> Run.

create table if not exists public.upload_pass (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
alter table public.upload_pass enable row level security;
revoke all on public.upload_pass from anon, authenticated;

create or replace function public.create_order_checked(
  p_pass uuid, p_slug text, p_customer_name text, p_note text, p_files jsonb, p_counter uuid default null)
returns table (order_id uuid, access_key uuid, token int, shop_id uuid, total numeric, paths text[])
language plpgsql security definer set search_path = public as $$
begin
  delete from public.upload_pass up where up.created_at < now() - interval '1 hour';
  delete from public.upload_pass up where up.id = p_pass and up.created_at > now() - interval '10 minutes';
  if not found then
    raise exception 'captcha_failed';
  end if;
  return query select * from public.create_order(p_slug, p_customer_name, p_note, p_files, p_counter);
end $$;
revoke all on function public.create_order_checked(uuid, text, text, text, jsonb, uuid) from public;
grant execute on function public.create_order_checked(uuid, text, text, text, jsonb, uuid) to anon, authenticated;

-- The old entry point is closed to the browser: orders must come through the check above.
revoke execute on function public.create_order(text, text, text, jsonb, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
