-- PrintQR v24 migration (2026-11-21): small photo thumbnails for the owner's order list.
-- Safe to run more than once. Needs v23.
--
-- The customer's phone makes a small JPEG (about 10 KB) of every photo it uploads and stores it next to
-- the photo as '<storage_path>.thumb.jpg'. The owner's order list shows that instead of downloading the
-- full photo for every thumbnail (Supabase image transformations need a paid Supabase plan).
-- Same rules as the photo itself: only the order's own new paths, only while it is uploading (30 min).
-- Old orders and reorders have no thumbnail; the app then falls back to the full photo.

create or replace function public.can_upload(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.order_files f join public.orders o on o.id = f.order_id
    where f.source_path is null
      and o.status = 'uploading' and o.created_at > now() - interval '30 minutes'
      and (f.storage_path = p_name
           or (p_name = f.storage_path || '.thumb.jpg' and f.mime like 'image/%'))
  );
$$;
grant execute on function public.can_upload(text) to anon, authenticated;

notify pgrst, 'reload schema';
