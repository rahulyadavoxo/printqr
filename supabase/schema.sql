-- PrintQR database schema for Supabase
-- Run this whole file once in Supabase Dashboard -> SQL Editor -> New query -> Run.

create extension if not exists pgcrypto;

-- ============ TABLES ============

create table if not exists public.shops (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,60}$'),
  address text,
  phone text,
  upi_id text,
  is_open boolean not null default true,
  -- price per printed page (A4). "double" = price per page when printed double-sided
  rates jsonb not null default '{"bw_single":2,"bw_double":1.5,"color_single":10,"color_double":8}'::jsonb,
  auto_delete_hours int not null default 24 check (auto_delete_hours between 1 and 168),
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  token int not null,
  access_key uuid not null default gen_random_uuid(),
  customer_name text,
  note text,
  status text not null default 'uploading'
    check (status in ('uploading','received','printing','ready','done','cancelled')),
  total numeric(10,2) not null default 0,
  files_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_shop_created on public.orders(shop_id, created_at desc);

create table if not exists public.order_files (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  mime text,
  size_bytes bigint,
  total_pages int not null check (total_pages between 1 and 2000),
  page_range text,
  pages_to_print int not null check (pages_to_print between 1 and 2000),
  copies int not null default 1 check (copies between 1 and 100),
  color boolean not null default false,
  duplex boolean not null default false,
  price numeric(10,2) not null
);
create index if not exists order_files_order on public.order_files(order_id);

-- ============ RLS ============

alter table public.shops enable row level security;
alter table public.orders enable row level security;
alter table public.order_files enable row level security;

drop policy if exists "owner reads shop" on public.shops;
create policy "owner reads shop" on public.shops for select to authenticated using (owner_id = auth.uid());
drop policy if exists "owner creates shop" on public.shops;
create policy "owner creates shop" on public.shops for insert to authenticated with check (owner_id = auth.uid());
drop policy if exists "owner updates shop" on public.shops;
create policy "owner updates shop" on public.shops for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "owner reads orders" on public.orders;
create policy "owner reads orders" on public.orders for select to authenticated
  using (shop_id in (select id from public.shops where owner_id = auth.uid()));
drop policy if exists "owner updates orders" on public.orders;
create policy "owner updates orders" on public.orders for update to authenticated
  using (shop_id in (select id from public.shops where owner_id = auth.uid()))
  with check (shop_id in (select id from public.shops where owner_id = auth.uid()));

drop policy if exists "owner reads files" on public.order_files;
create policy "owner reads files" on public.order_files for select to authenticated
  using (shop_id in (select id from public.shops where owner_id = auth.uid()));

-- Explicit grants (works even if "Automatically expose new tables" was turned off)
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update on public.shops to authenticated;
grant select on public.orders to authenticated;
grant select on public.order_files to authenticated;
grant all on public.shops, public.orders, public.order_files to service_role;

-- Owners may only change status (and updated_at) on orders, not totals/tokens.
revoke update on public.orders from authenticated, anon;
grant update (status, updated_at, files_deleted) on public.orders to authenticated;
revoke insert, update, delete on public.order_files from authenticated, anon;

-- ============ PUBLIC FUNCTIONS (customers, no login) ============

-- Shop info for the customer upload page
create or replace function public.get_shop_public(p_slug text)
returns table (id uuid, name text, address text, is_open boolean, rates jsonb, upi_id text)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.address, s.is_open, s.rates, s.upi_id from public.shops s where s.slug = p_slug;
$$;

-- Creates an order. Prices are calculated HERE from the shop's rates (never trusted from the browser).
-- p_files: [{"name":"a.pdf","mime":"application/pdf","size":1234,"total_pages":10,"page_range":"1-3","pages_to_print":3,"copies":1,"color":false,"duplex":false}]
create or replace function public.create_order(p_slug text, p_customer_name text, p_note text, p_files jsonb)
returns table (order_id uuid, access_key uuid, token int, shop_id uuid, total numeric, paths text[])
language plpgsql security definer set search_path = public as $$
declare
  v_shop public.shops;
  v_order public.orders;
  v_token int;
  v_total numeric(10,2) := 0;
  v_paths text[] := '{}';
  v_f jsonb;
  v_i int := 0;
  v_rate numeric;
  v_pages int;
  v_copies int;
  v_price numeric(10,2);
  v_path text;
  v_day_start timestamptz := (date_trunc('day', now() at time zone 'Asia/Kolkata')) at time zone 'Asia/Kolkata';
begin
  select * into v_shop from public.shops where slug = p_slug for update;
  if not found then raise exception 'Shop not found'; end if;
  if not v_shop.is_open then raise exception 'Shop is closed right now'; end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 then
    raise exception 'No files';
  end if;
  if jsonb_array_length(p_files) > 20 then raise exception 'Max 20 files per order'; end if;

  select coalesce(max(o.token), 0) + 1 into v_token
    from public.orders o where o.shop_id = v_shop.id and o.created_at >= v_day_start;

  insert into public.orders (shop_id, token, customer_name, note)
    values (v_shop.id, v_token, nullif(left(trim(coalesce(p_customer_name,'')), 60), ''), nullif(left(trim(coalesce(p_note,'')), 300), ''))
    returning * into v_order;

  for v_f in select * from jsonb_array_elements(p_files) loop
    v_i := v_i + 1;
    v_pages := greatest(1, least(2000, coalesce((v_f->>'pages_to_print')::int, 1)));
    v_copies := greatest(1, least(100, coalesce((v_f->>'copies')::int, 1)));
    v_rate := coalesce((v_shop.rates ->> (
      case when coalesce((v_f->>'color')::boolean, false) then 'color' else 'bw' end
      || case when coalesce((v_f->>'duplex')::boolean, false) then '_double' else '_single' end
    ))::numeric, 0);
    v_price := round(v_pages * v_copies * v_rate, 2);
    v_total := v_total + v_price;
    v_path := v_shop.id::text || '/' || v_order.id::text || '/' || v_i::text || '-' ||
      left(regexp_replace(coalesce(v_f->>'name','file'), '[^A-Za-z0-9._-]', '_', 'g'), 80);
    v_paths := v_paths || v_path;
    insert into public.order_files (order_id, shop_id, storage_path, file_name, mime, size_bytes,
        total_pages, page_range, pages_to_print, copies, color, duplex, price)
      values (v_order.id, v_shop.id, v_path, left(coalesce(v_f->>'name','file'), 200), v_f->>'mime',
        (v_f->>'size')::bigint,
        greatest(1, least(2000, coalesce((v_f->>'total_pages')::int, 1))),
        nullif(left(v_f->>'page_range', 60), ''), v_pages, v_copies,
        coalesce((v_f->>'color')::boolean, false), coalesce((v_f->>'duplex')::boolean, false), v_price);
  end loop;

  update public.orders set total = v_total where id = v_order.id;

  return query select v_order.id, v_order.access_key, v_token, v_shop.id, v_total, v_paths;
end $$;

-- Called after all files are uploaded. Moves order into the shop's queue.
create or replace function public.finalize_order(p_order_id uuid, p_key uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.orders set status = 'received', updated_at = now()
    where id = p_order_id and access_key = p_key and status = 'uploading';
  if not found then raise exception 'Order not found'; end if;
end $$;

-- Customer's status page
create or replace function public.get_order_status(p_order_id uuid, p_key uuid)
returns table (token int, status text, total numeric, created_at timestamptz, shop_name text, upi_id text, file_count int)
language sql stable security definer set search_path = public as $$
  select o.token, o.status, o.total, o.created_at, s.name, s.upi_id,
    (select count(*)::int from public.order_files f where f.order_id = o.id)
  from public.orders o join public.shops s on s.id = o.shop_id
  where o.id = p_order_id and o.access_key = p_key;
$$;

-- Used by storage policy: may this (anonymous) upload go to this path?
create or replace function public.can_upload(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.order_files f join public.orders o on o.id = f.order_id
    where f.storage_path = p_name and o.status = 'uploading' and o.created_at > now() - interval '30 minutes'
  );
$$;

-- Slug availability check for signup
create or replace function public.slug_available(p_slug text)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.shops where slug = p_slug);
$$;

-- Orders whose files should be deleted (used by the cleanup job with the service role)
create or replace function public.cleanup_candidates()
returns table (order_id uuid, status text, paths text[])
language sql stable security definer set search_path = public as $$
  select o.id, o.status, array(select f.storage_path from public.order_files f where f.order_id = o.id)
  from public.orders o join public.shops s on s.id = o.shop_id
  where o.files_deleted = false and (
    o.created_at < now() - make_interval(hours => s.auto_delete_hours)
    or (o.status = 'uploading' and o.created_at < now() - interval '1 hour')
  )
  limit 500;
$$;

revoke all on function public.cleanup_candidates() from public, anon, authenticated;
grant execute on function public.cleanup_candidates() to service_role;
grant execute on function public.get_shop_public(text) to anon, authenticated;
grant execute on function public.create_order(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.finalize_order(uuid, uuid) to anon, authenticated;
grant execute on function public.get_order_status(uuid, uuid) to anon, authenticated;
grant execute on function public.can_upload(text) to anon, authenticated;
grant execute on function public.slug_available(text) to anon, authenticated;

-- ============ STORAGE ============

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('uploads', 'uploads', false, 52428800, array[
  'application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif',
  'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/octet-stream'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "customer uploads" on storage.objects;
create policy "customer uploads" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'uploads' and public.can_upload(name));

drop policy if exists "owner reads uploads" on storage.objects;
create policy "owner reads uploads" on storage.objects for select to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] in (select id::text from public.shops where owner_id = auth.uid()));

drop policy if exists "owner deletes uploads" on storage.objects;
create policy "owner deletes uploads" on storage.objects for delete to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] in (select id::text from public.shops where owner_id = auth.uid()));

-- ============ REALTIME (live order queue) ============
do $$ begin
  alter publication supabase_realtime add table public.orders;
exception when duplicate_object then null; end $$;
