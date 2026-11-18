-- PrintQR v6 migration (2026-11-18): shop profile picture.
-- Adds shops.logo_url and a public storage bucket "shop-logos" (path: <shop_id>/<file>).
-- Owners can upload/replace/delete only inside their own shop's folder. No photo = the Print logo.
-- Safe to run more than once. Paste the whole file in Supabase -> SQL Editor -> New query -> Run.

alter table public.shops add column if not exists logo_url text;
grant update (logo_url) on public.shops to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shop-logos', 'shop-logos', true, 1048576, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "owner uploads shop logo" on storage.objects;
create policy "owner uploads shop logo" on storage.objects for insert to authenticated
  with check (bucket_id = 'shop-logos' and (storage.foldername(name))[1] in (select id::text from public.shops where owner_id = auth.uid()));
drop policy if exists "owner reads shop logo" on storage.objects;
create policy "owner reads shop logo" on storage.objects for select to authenticated
  using (bucket_id = 'shop-logos' and (storage.foldername(name))[1] in (select id::text from public.shops where owner_id = auth.uid()));
drop policy if exists "owner updates shop logo" on storage.objects;
create policy "owner updates shop logo" on storage.objects for update to authenticated
  using (bucket_id = 'shop-logos' and (storage.foldername(name))[1] in (select id::text from public.shops where owner_id = auth.uid()));
drop policy if exists "owner deletes shop logo" on storage.objects;
create policy "owner deletes shop logo" on storage.objects for delete to authenticated
  using (bucket_id = 'shop-logos' and (storage.foldername(name))[1] in (select id::text from public.shops where owner_id = auth.uid()));

notify pgrst, 'reload schema';
