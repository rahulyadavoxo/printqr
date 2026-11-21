-- PrintQR v21 migration (2026-11-21): security clean-up. Safe to run more than once.
-- 1. finalize_order stays server-only: orders must go through finalize-order (real page count, v11).
-- 2. The old captcha path (upload-pass + create_order_checked, v9) is gone; nothing calls it.
-- 3. shops.logo_url may only point at the shop's own file in the shop-logos bucket.

-- 1
revoke execute on function public.finalize_order(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_order(uuid, uuid) to service_role;

-- 2
drop function if exists public.create_order_checked(uuid, text, text, text, jsonb, uuid);
drop table if exists public.upload_pass;

-- 3
update public.shops set logo_url = null
where logo_url is not null
  and logo_url not like 'https://asqgdgzxkdksoikmffmd.supabase.co/storage/v1/object/public/shop-logos/' || id::text || '/%';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shops_logo_url_own_bucket') then
    alter table public.shops add constraint shops_logo_url_own_bucket check (
      logo_url is null
      or logo_url like 'https://asqgdgzxkdksoikmffmd.supabase.co/storage/v1/object/public/shop-logos/' || id::text || '/%');
  end if;
end $$;

notify pgrst, 'reload schema';
