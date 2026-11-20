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
  rates jsonb not null default '{"bw_single":2,"bw_double":1.5,"color_single":10,"color_double":8,"passport_sheet":40}'::jsonb,
  auto_delete_hours int not null default 24 check (auto_delete_hours between 1 and 168),
  -- Plan (written only by the Edge Functions with the service role; owners cannot change these)
  plan text not null default 'free' check (plan in ('free','pro')),
  plan_period text check (plan_period is null or plan_period in ('monthly','yearly')),
  plan_expires_at timestamptz,
  razorpay_subscription_id text,
  subscription_status text,
  created_at timestamptz not null default now()
);

-- Optional named counters (each has its own QR: shop link + ?c=<counter id>)
create table if not exists public.counters (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now()
);
create index if not exists counters_shop on public.counters(shop_id, created_at);

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
  counter_id uuid references public.counters(id) on delete set null,
  counter_name text,
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
  price numeric(10,2) not null,
  item_kind text not null default 'print' check (item_kind in ('print','passport')),
  photos int
);
create index if not exists order_files_order on public.order_files(order_id);

-- Upgrades for databases created before v2 (no-ops on a fresh install)
alter table public.shops alter column rates
  set default '{"bw_single":2,"bw_double":1.5,"color_single":10,"color_double":8,"passport_sheet":40}'::jsonb;
update public.shops set rates = rates || jsonb_build_object('passport_sheet', 40) where not (rates ? 'passport_sheet');
alter table public.orders add column if not exists counter_id uuid references public.counters(id) on delete set null;
alter table public.orders add column if not exists counter_name text;
alter table public.order_files add column if not exists item_kind text not null default 'print';
alter table public.order_files add column if not exists photos int;
do $$ begin
  alter table public.order_files add constraint order_files_item_kind_check check (item_kind in ('print','passport'));
exception when duplicate_object then null; end $$;
-- v3: plan columns
alter table public.shops add column if not exists plan text not null default 'free';
alter table public.shops add column if not exists plan_period text;
alter table public.shops add column if not exists plan_expires_at timestamptz;
alter table public.shops add column if not exists razorpay_subscription_id text;
alter table public.shops add column if not exists subscription_status text;
do $$ begin
  alter table public.shops add constraint shops_plan_check check (plan in ('free','pro'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.shops add constraint shops_plan_period_check check (plan_period is null or plan_period in ('monthly','yearly'));
exception when duplicate_object then null; end $$;
create index if not exists shops_rzp_sub on public.shops(razorpay_subscription_id);

-- Razorpay: private tables (service role only)
create table if not exists public.billing_plans (
  period text not null check (period in ('monthly','yearly')),
  amount int not null,
  razorpay_plan_id text not null,
  created_at timestamptz not null default now(),
  primary key (period, amount)
);
-- Webhook events already handled (idempotency).
create table if not exists public.billing_events (
  event_id text primary key,
  event text,
  received_at timestamptz not null default now()
);
alter table public.billing_plans enable row level security;
alter table public.billing_events enable row level security;

-- ============ RLS ============

alter table public.shops enable row level security;
alter table public.orders enable row level security;
alter table public.order_files enable row level security;
alter table public.counters enable row level security;
-- billing_plans / billing_events: RLS on (above) and no policies, only the service role uses them.

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

drop policy if exists "owner reads counters" on public.counters;
create policy "owner reads counters" on public.counters for select to authenticated
  using (shop_id in (select id from public.shops where owner_id = auth.uid()));
drop policy if exists "owner creates counters" on public.counters;
create policy "owner creates counters" on public.counters for insert to authenticated
  with check (shop_id in (select id from public.shops where owner_id = auth.uid()));
drop policy if exists "owner updates counters" on public.counters;
create policy "owner updates counters" on public.counters for update to authenticated
  using (shop_id in (select id from public.shops where owner_id = auth.uid()))
  with check (shop_id in (select id from public.shops where owner_id = auth.uid()));
drop policy if exists "owner deletes counters" on public.counters;
create policy "owner deletes counters" on public.counters for delete to authenticated
  using (shop_id in (select id from public.shops where owner_id = auth.uid()));

-- Explicit grants (works even if "Automatically expose new tables" was turned off)
grant usage on schema public to anon, authenticated, service_role;
grant select on public.shops to authenticated;
-- Owners may insert/update only these shop columns (never the plan columns).
revoke insert, update on public.shops from authenticated, anon;
grant insert (owner_id, name, slug, address, phone, upi_id, is_open, rates, auto_delete_hours) on public.shops to authenticated;
grant update (name, address, phone, upi_id, is_open, rates, auto_delete_hours) on public.shops to authenticated;
-- Shop profile picture (v6): see supabase/migrations/2026-11-18-v6-shop-photo.sql (also run it on fresh installs).
revoke all on public.billing_plans, public.billing_events from public, anon, authenticated;
grant all on public.billing_plans, public.billing_events to service_role;
grant select on public.orders to authenticated;
grant select on public.order_files to authenticated;
grant select, insert, update, delete on public.counters to authenticated;
grant all on public.shops, public.orders, public.order_files, public.counters to service_role;

-- Owners may only change status (and updated_at) on orders, not totals/tokens.
revoke update on public.orders from authenticated, anon;
grant update (status, updated_at, files_deleted) on public.orders to authenticated;
revoke insert, update, delete on public.order_files from authenticated, anon;

-- ============ PLANS (free / pro) ============

-- Pro = plan 'pro' and not expired. Also usable from PostgREST as a computed column: select=*,is_pro
create or replace function public.is_pro(s public.shops)
returns boolean language sql stable set search_path = public as $$
  select s.plan = 'pro' and s.plan_expires_at is not null and s.plan_expires_at > now();
$$;
create or replace function public.shop_is_pro(p_shop_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select public.is_pro(s) from public.shops s where s.id = p_shop_id), false);
$$;
grant execute on function public.is_pro(public.shops) to anon, authenticated, service_role;
revoke all on function public.shop_is_pro(uuid) from public, anon;
grant execute on function public.shop_is_pro(uuid) to authenticated, service_role;

-- How many named counters a FREE shop may have (the main queue is always there and is not a row).
-- 0 = free shops use only the main queue. Change the number here if the rule changes.
create or replace function public.free_counter_limit()
returns int language sql immutable as $$ select 0 $$;
grant execute on function public.free_counter_limit() to anon, authenticated, service_role;

-- Belt and braces: even if someone re-grants the table, a trigger resets plan columns for non-service callers.
create or replace function public.shops_guard_plan()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.plan := 'free';
      new.plan_period := null;
      new.plan_expires_at := null;
      new.razorpay_subscription_id := null;
      new.subscription_status := null;
    else
      new.plan := old.plan;
      new.plan_period := old.plan_period;
      new.plan_expires_at := old.plan_expires_at;
      new.razorpay_subscription_id := old.razorpay_subscription_id;
      new.subscription_status := old.subscription_status;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists shops_guard_plan on public.shops;
create trigger shops_guard_plan before insert or update on public.shops
  for each row execute function public.shops_guard_plan();

-- Free shops: no counters beyond the free limit.
create or replace function public.counters_plan_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_shop public.shops;
  v_count int;
begin
  select * into v_shop from public.shops where id = new.shop_id for update;
  if not found then raise exception 'Shop not found'; end if;
  if public.is_pro(v_shop) then return new; end if;
  select count(*) into v_count from public.counters where shop_id = new.shop_id;
  if v_count >= public.free_counter_limit() then
    raise exception 'More counters need the Pro plan';
  end if;
  return new;
end $$;
drop trigger if exists counters_plan_limit on public.counters;
create trigger counters_plan_limit before insert on public.counters
  for each row execute function public.counters_plan_limit();

-- ============ PUBLIC FUNCTIONS (customers, no login) ============

-- Customer page: is_pro decides ads and passport. Free shops get no passport_sheet rate,
-- so even an old cached app hides the passport option. Return type changed -> drop first.
drop function if exists public.get_shop_public(text);
create function public.get_shop_public(p_slug text)
returns table (id uuid, name text, address text, is_open boolean, rates jsonb, upi_id text, is_pro boolean)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.address, s.is_open,
    case when public.is_pro(s) then jsonb_build_object('passport_sheet', 40) || s.rates
         else s.rates - 'passport_sheet' end,
    s.upi_id, public.is_pro(s)
  from public.shops s where s.slug = p_slug;
$$;
grant execute on function public.get_shop_public(text) to anon, authenticated;

-- Counter name for the customer page. Free shops: only counters within the free limit (none by default).
create or replace function public.get_counter_public(p_slug text, p_counter uuid)
returns text language sql stable security definer set search_path = public as $$
  select c.name from public.counters c join public.shops s on s.id = c.shop_id
  where s.slug = p_slug and c.id = p_counter
    and (public.is_pro(s) or c.id in (
      select c2.id from public.counters c2 where c2.shop_id = s.id
      order by c2.created_at, c2.id limit public.free_counter_limit()));
$$;
grant execute on function public.get_counter_public(text, uuid) to anon, authenticated;

drop function if exists public.create_order(text, text, text, jsonb);

-- Prices are calculated HERE from the shop's rates (never trusted from the browser).
-- p_files: [{"name":"a.pdf","mime":"application/pdf","size":1234,"total_pages":10,"page_range":"1-3","pages_to_print":3,"copies":1,"color":false,"duplex":false}]
-- Passport sheet item (Pro only): {"kind":"passport","name":"passport.pdf","mime":"application/pdf","size":1234,"photos":16}
--   -> sheets = ceil(photos / 30) (30 photos of 35x45 mm fit on one A4), price = sheets * rates.passport_sheet
-- Free shops: passport items are rejected; counter QRs beyond the free limit go to the main queue.
create or replace function public.create_order(p_slug text, p_customer_name text, p_note text, p_files jsonb, p_counter uuid default null)
returns table (order_id uuid, access_key uuid, token int, shop_id uuid, total numeric, paths text[])
language plpgsql security definer set search_path = public as $$
declare
  v_shop public.shops;
  v_pro boolean;
  v_order public.orders;
  v_token int;
  v_total numeric(10,2) := 0;
  v_paths text[] := '{}';
  v_f jsonb;
  v_i int := 0;
  v_rate numeric;
  v_pages int;
  v_total_pages int;
  v_copies int;
  v_color boolean;
  v_duplex boolean;
  v_kind text;
  v_photos int;
  v_range text;
  v_price numeric(10,2);
  v_path text;
  v_counter_id uuid;
  v_counter_name text;
  v_day_start timestamptz := (date_trunc('day', now() at time zone 'Asia/Kolkata')) at time zone 'Asia/Kolkata';
begin
  select * into v_shop from public.shops where slug = p_slug for update;
  if not found then raise exception 'Shop not found'; end if;
  if not v_shop.is_open then raise exception 'Shop is closed right now'; end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 then
    raise exception 'No files';
  end if;
  if jsonb_array_length(p_files) > 20 then raise exception 'Max 20 files per order'; end if;
  v_pro := public.is_pro(v_shop);
  if not v_pro and exists (select 1 from jsonb_array_elements(p_files) x where x->>'kind' = 'passport') then
    raise exception 'Passport photo sheet is not available at this shop';
  end if;

  -- Unknown / deleted / locked counter -> order goes to the default (no counter), so old QRs keep working.
  if p_counter is not null then
    select c.id, c.name into v_counter_id, v_counter_name
      from public.counters c where c.id = p_counter and c.shop_id = v_shop.id
        and (v_pro or c.id in (
          select c2.id from public.counters c2 where c2.shop_id = v_shop.id
          order by c2.created_at, c2.id limit public.free_counter_limit()));
  end if;

  select coalesce(max(o.token), 0) + 1 into v_token
    from public.orders o where o.shop_id = v_shop.id and o.created_at >= v_day_start;

  insert into public.orders (shop_id, token, customer_name, note, counter_id, counter_name)
    values (v_shop.id, v_token, nullif(left(trim(coalesce(p_customer_name,'')), 60), ''),
      nullif(left(trim(coalesce(p_note,'')), 300), ''), v_counter_id, v_counter_name)
    returning * into v_order;

  for v_f in select * from jsonb_array_elements(p_files) loop
    v_i := v_i + 1;
    v_kind := case when v_f->>'kind' = 'passport' then 'passport' else 'print' end;
    if v_kind = 'passport' then
      v_photos := greatest(1, least(300, coalesce((v_f->>'photos')::int, 8)));
      v_pages := ceil(v_photos / 30.0)::int;
      v_total_pages := v_pages;
      v_copies := 1;
      v_color := true;
      v_duplex := false;
      v_range := null;
      v_rate := coalesce((v_shop.rates ->> 'passport_sheet')::numeric, 40);
    else
      v_photos := null;
      v_pages := greatest(1, least(2000, coalesce((v_f->>'pages_to_print')::int, 1)));
      v_total_pages := greatest(1, least(2000, coalesce((v_f->>'total_pages')::int, 1)));
      v_copies := greatest(1, least(100, coalesce((v_f->>'copies')::int, 1)));
      v_color := coalesce((v_f->>'color')::boolean, false);
      v_duplex := coalesce((v_f->>'duplex')::boolean, false);
      v_range := nullif(left(v_f->>'page_range', 60), '');
      v_rate := coalesce((v_shop.rates ->> (
        case when v_color then 'color' else 'bw' end || case when v_duplex then '_double' else '_single' end
      ))::numeric, 0);
    end if;
    v_price := round(v_pages * v_copies * v_rate, 2);
    v_total := v_total + v_price;
    v_path := v_shop.id::text || '/' || v_order.id::text || '/' || v_i::text || '-' ||
      left(regexp_replace(coalesce(v_f->>'name','file'), '[^A-Za-z0-9._-]', '_', 'g'), 80);
    v_paths := v_paths || v_path;
    insert into public.order_files (order_id, shop_id, storage_path, file_name, mime, size_bytes,
        total_pages, page_range, pages_to_print, copies, color, duplex, price, item_kind, photos)
      values (v_order.id, v_shop.id, v_path, left(coalesce(v_f->>'name','file'), 200), v_f->>'mime',
        (v_f->>'size')::bigint, v_total_pages, v_range, v_pages, v_copies, v_color, v_duplex, v_price,
        v_kind, v_photos);
  end loop;

  update public.orders set total = v_total where id = v_order.id;

  return query select v_order.id, v_order.access_key, v_token, v_shop.id, v_total, v_paths;
end $$;

grant execute on function public.create_order(text, text, text, jsonb, uuid) to anon, authenticated;

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
grant execute on function public.create_order(text, text, text, jsonb, uuid) to anon, authenticated;
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

notify pgrst, 'reload schema';


-- PrintQR v7 migration (2026-11-18): security fixes for customer uploads.
--  * create_order: rate limits (10 orders / 10 min per network, 20 unfinished or 60 total per 10 min per shop),
--    file-type allowlist by extension + matching type, size checks, 200 MB per order.
--  * finalize_order: the order goes to the shop only if every file is really in storage with the declared size.
--  * uploads bucket: no more application/octet-stream (unknown files).
-- Safe to run more than once. Paste the whole file in Supabase -> SQL Editor -> New query -> Run.

create table if not exists public.order_rate (
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists order_rate_ip_idx on public.order_rate (ip_hash, created_at);
create index if not exists order_rate_time_idx on public.order_rate (created_at);
alter table public.order_rate enable row level security;
revoke all on public.order_rate from anon, authenticated;

-- Caller's IP from the API gateway (Cloudflare sets cf-connecting-ip), stored only as a hash.
create or replace function public.request_ip_hash()
returns text language plpgsql stable set search_path = public as $$
declare
  h json;
  ip text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return null;
  end;
  if h is null then return null; end if;
  ip := coalesce(h->>'cf-connecting-ip', h->>'x-real-ip', split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1));
  ip := nullif(trim(ip), '');
  if ip is null then return null; end if;
  return md5('printqr:' || ip);
end $$;
revoke all on function public.request_ip_hash() from public, anon, authenticated;

-- The only file types customers may send. Extension -> the one content type allowed for it.
create or replace function public.upload_mime_for(p_ext text)
returns text language sql immutable as $$
  select case lower(coalesce(p_ext, ''))
    when 'pdf' then 'application/pdf'
    when 'jpg' then 'image/jpeg'
    when 'jpeg' then 'image/jpeg'
    when 'png' then 'image/png'
    when 'webp' then 'image/webp'
    when 'heic' then 'image/heic'
    when 'heif' then 'image/heif'
    when 'doc' then 'application/msword'
    when 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    when 'xls' then 'application/vnd.ms-excel'
    when 'xlsx' then 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    when 'ppt' then 'application/vnd.ms-powerpoint'
    when 'pptx' then 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    else null end
$$;
grant execute on function public.upload_mime_for(text) to anon, authenticated;

create or replace function public.create_order(p_slug text, p_customer_name text, p_note text, p_files jsonb, p_counter uuid default null)
returns table (order_id uuid, access_key uuid, token int, shop_id uuid, total numeric, paths text[])
language plpgsql security definer set search_path = public as $$
declare
  v_shop public.shops;
  v_pro boolean;
  v_order public.orders;
  v_token int;
  v_total numeric(10,2) := 0;
  v_paths text[] := '{}';
  v_f jsonb;
  v_i int := 0;
  v_rate numeric;
  v_pages int;
  v_total_pages int;
  v_copies int;
  v_color boolean;
  v_duplex boolean;
  v_kind text;
  v_photos int;
  v_range text;
  v_price numeric(10,2);
  v_path text;
  v_counter_id uuid;
  v_counter_name text;
  v_ip text;
  v_ext text;
  v_mime text;
  v_size bigint;
  v_bytes bigint := 0;
  v_day_start timestamptz := (date_trunc('day', now() at time zone 'Asia/Kolkata')) at time zone 'Asia/Kolkata';
begin
  select * into v_shop from public.shops where slug = p_slug for update;
  if not found then raise exception 'Shop not found'; end if;
  if not v_shop.is_open then raise exception 'Shop is closed right now'; end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 then
    raise exception 'No files';
  end if;
  if jsonb_array_length(p_files) > 20 then raise exception 'Max 20 files per order'; end if;

  -- v7 anti-spam: per network (IP, hashed) and per shop. The shop row is locked above, so counts are exact.
  v_ip := public.request_ip_hash();
  if v_ip is not null then
    delete from public.order_rate where created_at < now() - interval '1 day';
    if (select count(*) from public.order_rate r where r.ip_hash = v_ip and r.created_at > now() - interval '10 minutes') >= 10 then
      raise exception 'Too many orders from this network. Please wait a few minutes and try again.';
    end if;
  end if;
  if (select count(*) from public.orders o where o.shop_id = v_shop.id and o.status = 'uploading'
        and o.created_at > now() - interval '30 minutes') >= 20
     or (select count(*) from public.orders o where o.shop_id = v_shop.id and o.created_at > now() - interval '10 minutes') >= 60 then
    raise exception 'This shop is getting too many orders right now. Please try again in a few minutes.';
  end if;

  -- v7 file checks: only print-able types (extension decides the type), real sizes, 200 MB per order.
  for v_f in select * from jsonb_array_elements(p_files) loop
    v_ext := lower(substring(coalesce(v_f->>'name', '') from '\.([A-Za-z0-9]+)$'));
    v_mime := public.upload_mime_for(v_ext);
    if v_mime is null or coalesce(v_f->>'mime', '') <> v_mime then
      raise exception 'File type not allowed: %. Send PDF, photo, Word, Excel or PowerPoint files.', left(coalesce(v_f->>'name', 'file'), 60);
    end if;
    v_size := coalesce((v_f->>'size')::bigint, 0);
    if v_size < 1 or v_size > 52428800 then raise exception 'Each file must be under 50 MB'; end if;
    v_bytes := v_bytes + v_size;
  end loop;
  if v_bytes > 209715200 then raise exception 'One order can be up to 200 MB in total'; end if;
  if v_ip is not null then insert into public.order_rate (ip_hash) values (v_ip); end if;
  v_pro := public.is_pro(v_shop);
  if not v_pro and exists (select 1 from jsonb_array_elements(p_files) x where x->>'kind' = 'passport') then
    raise exception 'Passport photo sheet is not available at this shop';
  end if;

  -- Unknown / deleted / locked counter -> order goes to the default (no counter), so old QRs keep working.
  if p_counter is not null then
    select c.id, c.name into v_counter_id, v_counter_name
      from public.counters c where c.id = p_counter and c.shop_id = v_shop.id
        and (v_pro or c.id in (
          select c2.id from public.counters c2 where c2.shop_id = v_shop.id
          order by c2.created_at, c2.id limit public.free_counter_limit()));
  end if;

  select coalesce(max(o.token), 0) + 1 into v_token
    from public.orders o where o.shop_id = v_shop.id and o.created_at >= v_day_start;

  insert into public.orders (shop_id, token, customer_name, note, counter_id, counter_name)
    values (v_shop.id, v_token, nullif(left(trim(coalesce(p_customer_name,'')), 60), ''),
      nullif(left(trim(coalesce(p_note,'')), 300), ''), v_counter_id, v_counter_name)
    returning * into v_order;

  for v_f in select * from jsonb_array_elements(p_files) loop
    v_i := v_i + 1;
    v_kind := case when v_f->>'kind' = 'passport' then 'passport' else 'print' end;
    if v_kind = 'passport' then
      v_photos := greatest(1, least(300, coalesce((v_f->>'photos')::int, 8)));
      v_pages := ceil(v_photos / 30.0)::int;
      v_total_pages := v_pages;
      v_copies := 1;
      v_color := true;
      v_duplex := false;
      v_range := null;
      v_rate := coalesce((v_shop.rates ->> 'passport_sheet')::numeric, 40);
    else
      v_photos := null;
      v_pages := greatest(1, least(2000, coalesce((v_f->>'pages_to_print')::int, 1)));
      v_total_pages := greatest(1, least(2000, coalesce((v_f->>'total_pages')::int, 1)));
      v_copies := greatest(1, least(100, coalesce((v_f->>'copies')::int, 1)));
      v_color := coalesce((v_f->>'color')::boolean, false);
      v_duplex := coalesce((v_f->>'duplex')::boolean, false);
      v_range := nullif(left(v_f->>'page_range', 60), '');
      v_rate := coalesce((v_shop.rates ->> (
        case when v_color then 'color' else 'bw' end || case when v_duplex then '_double' else '_single' end
      ))::numeric, 0);
    end if;
    v_price := round(v_pages * v_copies * v_rate, 2);
    v_total := v_total + v_price;
    v_path := v_shop.id::text || '/' || v_order.id::text || '/' || v_i::text || '-' ||
      left(regexp_replace(coalesce(v_f->>'name','file'), '[^A-Za-z0-9._-]', '_', 'g'), 80);
    v_paths := v_paths || v_path;
    insert into public.order_files (order_id, shop_id, storage_path, file_name, mime, size_bytes,
        total_pages, page_range, pages_to_print, copies, color, duplex, price, item_kind, photos)
      values (v_order.id, v_shop.id, v_path, left(coalesce(v_f->>'name','file'), 200), v_f->>'mime',
        (v_f->>'size')::bigint, v_total_pages, v_range, v_pages, v_copies, v_color, v_duplex, v_price,
        v_kind, v_photos);
  end loop;

  update public.orders set total = v_total where id = v_order.id;

  return query select v_order.id, v_order.access_key, v_token, v_shop.id, v_total, v_paths;
end $$;

grant execute on function public.create_order(text, text, text, jsonb, uuid) to anon, authenticated;

-- Called after all files are uploaded. Moves the order into the shop's queue only when every file
-- is really in storage with the size create_order was told.
create or replace function public.finalize_order(p_order_id uuid, p_key uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_missing int;
begin
  select o.id into v_id from public.orders o
    where o.id = p_order_id and o.access_key = p_key and o.status = 'uploading' for update;
  if not found then raise exception 'Order not found'; end if;
  select count(*) into v_missing from public.order_files f
    where f.order_id = v_id and not exists (
      select 1 from storage.objects so
      where so.bucket_id = 'uploads' and so.name = f.storage_path
        and (so.metadata->>'size')::bigint = f.size_bytes);
  if v_missing > 0 then raise exception 'Some files did not upload completely. Please try again.'; end if;
  update public.orders set status = 'received', updated_at = now() where id = v_id;
end $$;
grant execute on function public.finalize_order(uuid, uuid) to anon, authenticated;

update storage.buckets set allowed_mime_types = array[
  'application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif',
  'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation']
where id = 'uploads';

notify pgrst, 'reload schema';


-- PrintQR v8 migration (2026-11-18): privacy + rate checks.
--  * When an order's files are deleted (auto-delete or the owner), the customer's name and note are cleared
--    and file names become "file.pdf", "file.jpg" ... Token, amount, pages and status stay for reports.
--    Orders whose files were already deleted are cleaned once, below.
--  * Rates must be numbers from 0 to 10000 (checked for every new save).
-- Safe to run more than once. Paste the whole file in Supabase -> SQL Editor -> New query -> Run.

create or replace function public.anon_file_name(p_name text)
returns text language sql immutable as $$
  select 'file' || coalesce('.' || lower(substring(coalesce(p_name, '') from '\.([A-Za-z0-9]{1,5})$')), '')
$$;

create or replace function public.orders_purge_personal()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.files_deleted and not coalesce(old.files_deleted, false) then
    new.customer_name := null;
    new.note := null;
    update public.order_files f
      set file_name = public.anon_file_name(f.file_name),
          storage_path = regexp_replace(f.storage_path, '/([0-9]+)-[^/]*$', '/\1-' || public.anon_file_name(f.file_name))
      where f.order_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists orders_purge_personal on public.orders;
create trigger orders_purge_personal before update of files_deleted on public.orders
  for each row execute function public.orders_purge_personal();

-- One-time clean-up of orders already deleted.
update public.orders set customer_name = null, note = null
  where files_deleted and (customer_name is not null or note is not null);
update public.order_files f
  set file_name = public.anon_file_name(f.file_name),
      storage_path = regexp_replace(f.storage_path, '/([0-9]+)-[^/]*$', '/\1-' || public.anon_file_name(f.file_name))
  from public.orders o
  where o.id = f.order_id and o.files_deleted and f.file_name <> public.anon_file_name(f.file_name);

-- Rates: every value a number between 0 and 10000.
create or replace function public.rates_valid(r jsonb)
returns boolean language sql immutable as $$
  select jsonb_typeof(r) = 'object' and not exists (
    select 1 from jsonb_each(r) e
    where jsonb_typeof(e.value) <> 'number' or (e.value)::numeric < 0 or (e.value)::numeric > 10000)
$$;
alter table public.shops drop constraint if exists shops_rates_valid;
alter table public.shops add constraint shops_rates_valid check (public.rates_valid(rates)) not valid;

notify pgrst, 'reload schema';


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

-- v10: no CAPTCHA on orders
grant execute on function public.create_order(text, text, text, jsonb, uuid) to anon, authenticated;

-- ===== v12 admin panel (also in migrations/2026-11-19-v12-admin.sql) =====
-- PrintQR v12 migration (2026-11-19): admin panel (#/admin).
-- Admins are listed in public.admins. Every admin function checks is_admin() inside the database,
-- so hiding the page is not the security: a non-admin calling these functions gets 'not allowed'.
-- Safe to run more than once. Paste the whole file in Supabase -> SQL Editor -> New query -> Run.
-- LAST LINE: put your own login email there so you become the admin.

-- ---------- who is admin ----------
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------- what admins did ----------
create table if not exists public.admin_log (
  id bigint generated always as identity primary key,
  admin_id uuid,
  action text not null,
  shop_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);
alter table public.admin_log enable row level security;
revoke all on public.admin_log from anon, authenticated;

-- ---------- blocking a shop ----------
alter table public.shops add column if not exists blocked boolean not null default false;
alter table public.shops add column if not exists blocked_reason text;

-- Owners cannot change plan or block columns themselves (admin functions run as the definer, so they can).
create or replace function public.shops_guard_plan()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.plan := 'free';
      new.plan_period := null;
      new.plan_expires_at := null;
      new.razorpay_subscription_id := null;
      new.subscription_status := null;
      new.blocked := false;
      new.blocked_reason := null;
    else
      new.plan := old.plan;
      new.plan_period := old.plan_period;
      new.plan_expires_at := old.plan_expires_at;
      new.razorpay_subscription_id := old.razorpay_subscription_id;
      new.subscription_status := old.subscription_status;
      new.blocked := old.blocked;
      new.blocked_reason := old.blocked_reason;
    end if;
  end if;
  return new;
end $$;

-- A blocked shop's QR page shows "Shop not found" and takes no orders.
create or replace function public.get_shop_public(p_slug text)
returns table (id uuid, name text, address text, is_open boolean, rates jsonb, upi_id text, is_pro boolean)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.address, s.is_open,
    case when public.is_pro(s) then jsonb_build_object('passport_sheet', 40) || s.rates
         else s.rates - 'passport_sheet' end,
    s.upi_id, public.is_pro(s)
  from public.shops s where s.slug = p_slug and not s.blocked;
$$;
grant execute on function public.get_shop_public(text) to anon, authenticated;

create or replace function public.orders_block_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.shops s where s.id = new.shop_id and s.blocked) then
    raise exception 'Shop not found';
  end if;
  return new;
end $$;
drop trigger if exists orders_block_guard on public.orders;
create trigger orders_block_guard before insert on public.orders
  for each row execute function public.orders_block_guard();

-- ---------- admin functions ----------
create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select jsonb_build_object(
    'shops_total',   (select count(*) from public.shops),
    'shops_today',   (select count(*) from public.shops where created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
    'shops_week',    (select count(*) from public.shops where created_at >= now() - interval '7 days'),
    'pro_active',    (select count(*) from public.shops s where public.is_pro(s)),
    'pro_paid',      (select count(*) from public.shops s where public.is_pro(s) and s.razorpay_subscription_id is not null),
    'pro_monthly',   (select count(*) from public.shops s where public.is_pro(s) and s.razorpay_subscription_id is not null and s.plan_period = 'monthly'),
    'pro_yearly',    (select count(*) from public.shops s where public.is_pro(s) and s.razorpay_subscription_id is not null and s.plan_period = 'yearly'),
    'blocked',       (select count(*) from public.shops where blocked),
    'orders_today',  (select count(*) from public.orders where status <> 'uploading' and created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
    'orders_week',   (select count(*) from public.orders where status <> 'uploading' and created_at >= now() - interval '7 days'),
    'orders_total',  (select count(*) from public.orders where status <> 'uploading'),
    'storage_bytes', (select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o where o.bucket_id = 'uploads'),
    'files_waiting', (select count(*) from public.orders where not files_deleted and status <> 'uploading')
  ) into r;
  return r;
end $$;

create or replace function public.admin_shops(p_q text default '', p_limit int default 50, p_offset int default 0)
returns table (
  id uuid, name text, slug text, owner_email text, phone text, created_at timestamptz,
  plan text, plan_period text, plan_expires_at timestamptz, is_pro boolean, paid boolean, subscription_status text,
  blocked boolean, blocked_reason text, is_open boolean,
  counters int, orders_total int, orders_week int, last_order_at timestamptz, scans int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return query
  select s.id, s.name, s.slug, u.email::text, s.phone, s.created_at,
    s.plan, s.plan_period, s.plan_expires_at, public.is_pro(s), s.razorpay_subscription_id is not null, s.subscription_status,
    s.blocked, s.blocked_reason, s.is_open,
    (select count(*)::int from public.counters c where c.shop_id = s.id),
    (select count(*)::int from public.orders o where o.shop_id = s.id and o.status <> 'uploading'),
    (select count(*)::int from public.orders o where o.shop_id = s.id and o.status <> 'uploading' and o.created_at >= now() - interval '7 days'),
    (select max(o.created_at) from public.orders o where o.shop_id = s.id and o.status <> 'uploading'),
    coalesce((select sum(q.scans)::int from public.qr_links q where q.shop_id = s.id), 0)
  from public.shops s
  left join auth.users u on u.id = s.owner_id
  where coalesce(p_q, '') = ''
     or s.name ilike '%' || p_q || '%'
     or s.slug ilike '%' || p_q || '%'
     or u.email ilike '%' || p_q || '%'
     or coalesce(s.phone, '') ilike '%' || p_q || '%'
  order by s.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- p_days > 0: give or extend Pro by that many days (added after the current end if still active).
-- p_days = 0: remove Pro now. Razorpay keeps billing a paid shop until it is cancelled there.
create or replace function public.admin_set_pro(p_shop uuid, p_days int)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  v_shop public.shops;
  v_end timestamptz;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if p_days is null or p_days < 0 or p_days > 3660 then raise exception 'bad days'; end if;
  select * into v_shop from public.shops where id = p_shop for update;
  if not found then raise exception 'Shop not found'; end if;
  if p_days = 0 then
    update public.shops set plan = 'free', plan_expires_at = now() where id = p_shop;
    v_end := now();
  else
    v_end := greatest(coalesce(v_shop.plan_expires_at, now()), now()) + make_interval(days => p_days);
    update public.shops set plan = 'pro', plan_expires_at = v_end where id = p_shop;
  end if;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), case when p_days = 0 then 'pro_removed' else 'pro_given' end, p_shop,
            jsonb_build_object('days', p_days, 'until', v_end, 'before', v_shop.plan_expires_at));
  return v_end;
end $$;

create or replace function public.admin_set_blocked(p_shop uuid, p_blocked boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  update public.shops set blocked = coalesce(p_blocked, false),
    blocked_reason = case when p_blocked then left(nullif(trim(p_reason), ''), 200) else null end
  where id = p_shop;
  if not found then raise exception 'Shop not found'; end if;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), case when p_blocked then 'blocked' else 'unblocked' end, p_shop, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.admin_recent_log(p_limit int default 30)
returns table (created_at timestamptz, action text, shop_id uuid, shop_name text, detail jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return query
  select l.created_at, l.action, l.shop_id, s.name, l.detail
  from public.admin_log l left join public.shops s on s.id = l.shop_id
  order by l.created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 200);
end $$;

revoke all on function public.admin_overview() from public, anon;
revoke all on function public.admin_shops(text, int, int) from public, anon;
revoke all on function public.admin_set_pro(uuid, int) from public, anon;
revoke all on function public.admin_set_blocked(uuid, boolean, text) from public, anon;
revoke all on function public.admin_recent_log(int) from public, anon;
grant execute on function public.admin_overview() to authenticated;
grant execute on function public.admin_shops(text, int, int) to authenticated;
grant execute on function public.admin_set_pro(uuid, int) to authenticated;
grant execute on function public.admin_set_blocked(uuid, boolean, text) to authenticated;
grant execute on function public.admin_recent_log(int) to authenticated;

notify pgrst, 'reload schema';


-- ================= v13 (2026-11-19): full admin panel =================
-- PrintQR v13 migration (2026-11-19): full admin panel.
--  * App settings (announcement, maintenance mode, minimum app version, free counter limit).
--  * Users, Orders, Payments, Spam watch (top shops / networks, blocked networks, customer reports).
--  * Shop tools: reset QR codes, change name, remove photo.
-- Needs v12 first. Safe to run more than once. Paste the whole file in Supabase -> SQL Editor -> New query -> Run.

-- ---------- app settings (one row) ----------
create table if not exists public.app_settings (
  id int primary key default 1 check (id = 1),
  announcement text,
  announcement_hi text,
  maintenance boolean not null default false,
  maintenance_msg text,
  min_app_version text,
  free_counter_limit int not null default 0 check (free_counter_limit between 0 and 20),
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (1) on conflict do nothing;
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

create or replace function public.get_app_settings()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'announcement', s.announcement, 'announcement_hi', s.announcement_hi,
    'maintenance', s.maintenance, 'maintenance_msg', s.maintenance_msg,
    'min_app_version', s.min_app_version, 'free_counter_limit', s.free_counter_limit)
  from public.app_settings s where s.id = 1;
$$;
grant execute on function public.get_app_settings() to anon, authenticated;

-- The free counter limit now comes from settings (was a fixed 0).
create or replace function public.free_counter_limit()
returns int language sql stable security definer set search_path = public as $$
  select coalesce((select free_counter_limit from public.app_settings where id = 1), 0)
$$;
grant execute on function public.free_counter_limit() to anon, authenticated, service_role;

-- ---------- blocked networks + customer reports ----------
create table if not exists public.blocked_ips (
  ip_hash text primary key,
  reason text,
  created_at timestamptz not null default now()
);
alter table public.blocked_ips enable row level security;
revoke all on public.blocked_ips from anon, authenticated;

create table if not exists public.shop_reports (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops(id) on delete cascade,
  reason text not null,
  ip_hash text,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists shop_reports_open on public.shop_reports (resolved, created_at desc);
alter table public.shop_reports enable row level security;
revoke all on public.shop_reports from anon, authenticated;

-- Customer reports a shop from its upload page. At most 5 reports a day per network.
create or replace function public.report_shop(p_slug text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_shop uuid;
  v_ip text := coalesce(public.request_ip_hash(), 'unknown');
  v_reason text := left(trim(coalesce(p_reason, '')), 300);
begin
  if char_length(v_reason) < 3 then raise exception 'Please write what is wrong'; end if;
  select id into v_shop from public.shops where slug = p_slug;
  if v_shop is null then raise exception 'Shop not found'; end if;
  if (select count(*) from public.shop_reports where ip_hash = v_ip and created_at > now() - interval '1 day') >= 5 then
    raise exception 'Too many reports. Please try again tomorrow.';
  end if;
  insert into public.shop_reports (shop_id, reason, ip_hash) values (v_shop, v_reason, v_ip);
end $$;
grant execute on function public.report_shop(text, text) to anon, authenticated;

-- New orders stop for blocked shops, blocked networks and maintenance mode.
create or replace function public.orders_block_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.shops s where s.id = new.shop_id and s.blocked) then
    raise exception 'Shop not found';
  end if;
  if coalesce((select maintenance from public.app_settings where id = 1), false) then
    raise exception 'New orders are paused for a short while. Please try again later.';
  end if;
  if exists (select 1 from public.blocked_ips b where b.ip_hash = public.request_ip_hash()) then
    raise exception 'Too many orders from this network. Please wait a few minutes and try again.';
  end if;
  return new;
end $$;
drop trigger if exists orders_block_guard on public.orders;
create trigger orders_block_guard before insert on public.orders
  for each row execute function public.orders_block_guard();

-- ---------- overview (adds payments, cleanup, reports, stuck orders) ----------
create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r jsonb;
  v_cron timestamptz;
  v_cron_fail int;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select jsonb_build_object(
    'shops_total',   (select count(*) from public.shops),
    'shops_today',   (select count(*) from public.shops where created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
    'shops_week',    (select count(*) from public.shops where created_at >= now() - interval '7 days'),
    'pro_active',    (select count(*) from public.shops s where public.is_pro(s)),
    'pro_paid',      (select count(*) from public.shops s where public.is_pro(s) and s.razorpay_subscription_id is not null),
    'pro_monthly',   (select count(*) from public.shops s where public.is_pro(s) and s.razorpay_subscription_id is not null and s.plan_period = 'monthly'),
    'pro_yearly',    (select count(*) from public.shops s where public.is_pro(s) and s.razorpay_subscription_id is not null and s.plan_period = 'yearly'),
    'pay_failed',    (select count(*) from public.shops where subscription_status in ('halted', 'pending')),
    'blocked',       (select count(*) from public.shops where blocked),
    'orders_today',  (select count(*) from public.orders where status <> 'uploading' and created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
    'orders_week',   (select count(*) from public.orders where status <> 'uploading' and created_at >= now() - interval '7 days'),
    'orders_total',  (select count(*) from public.orders where status <> 'uploading'),
    'orders_stuck',  (select count(*) from public.orders where not files_deleted and
                        ((status = 'uploading' and created_at < now() - interval '1 hour')
                         or (status in ('received', 'printing') and created_at < now() - interval '1 day'))),
    'storage_bytes', (select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o where o.bucket_id = 'uploads'),
    'files_waiting', (select count(*) from public.orders where not files_deleted and status <> 'uploading'),
    'reports_open',  (select count(*) from public.shop_reports where not resolved),
    'users_total',   (select count(*) from auth.users)
  ) into r;
  begin
    select max(d.end_time) filter (where d.status = 'succeeded'),
           count(*) filter (where d.status = 'failed' and d.start_time > now() - interval '1 day')
      into v_cron, v_cron_fail
    from cron.job_run_details d where d.start_time > now() - interval '7 days';
    r := r || jsonb_build_object('cleanup_last', v_cron, 'cleanup_failed_day', v_cron_fail);
  exception when others then
    r := r || jsonb_build_object('cleanup_last', null, 'cleanup_failed_day', null);
  end;
  return r;
end $$;

-- ---------- users ----------
create or replace function public.admin_users(p_q text default '', p_limit int default 50, p_offset int default 0)
returns table (user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz,
  confirmed boolean, banned boolean, shop_id uuid, shop_name text, is_admin boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return query
  select u.id, u.email::text, u.created_at, u.last_sign_in_at,
    u.email_confirmed_at is not null, coalesce(u.banned_until > now(), false),
    s.id, s.name, exists (select 1 from public.admins a where a.user_id = u.id)
  from auth.users u left join public.shops s on s.owner_id = u.id
  where coalesce(p_q, '') = '' or u.email ilike '%' || p_q || '%' or coalesce(s.name, '') ilike '%' || p_q || '%'
  order by u.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- ---------- orders (details only; files are never opened here) ----------
-- p_filter: 'all' | 'stuck' | 'files' (files still stored)
create or replace function public.admin_orders(p_q text default '', p_filter text default 'all', p_limit int default 50, p_offset int default 0)
returns table (id uuid, token int, shop_id uuid, shop_name text, status text, total numeric, files int, bytes bigint,
  files_deleted boolean, counter_name text, created_at timestamptz, updated_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return query
  select o.id, o.token, o.shop_id, s.name, o.status, o.total,
    (select count(*)::int from public.order_files f where f.order_id = o.id),
    (select coalesce(sum(f.size_bytes), 0)::bigint from public.order_files f where f.order_id = o.id),
    o.files_deleted, o.counter_name, o.created_at, o.updated_at
  from public.orders o join public.shops s on s.id = o.shop_id
  where (coalesce(p_q, '') = '' or s.name ilike '%' || p_q || '%' or s.slug ilike '%' || p_q || '%' or o.token::text = trim(p_q))
    and (coalesce(p_filter, 'all') = 'all'
      or (p_filter = 'files' and not o.files_deleted and o.status <> 'uploading')
      or (p_filter = 'stuck' and not o.files_deleted and
          ((o.status = 'uploading' and o.created_at < now() - interval '1 hour')
           or (o.status in ('received', 'printing') and o.created_at < now() - interval '1 day'))))
  order by o.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- ---------- payments ----------
create or replace function public.admin_payments()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'subs', coalesce((select jsonb_agg(x order by x.plan_expires_at desc nulls last) from (
      select s.id as shop_id, s.name, u.email::text as email, s.plan_period, s.subscription_status,
        s.plan_expires_at, s.razorpay_subscription_id as sub_id, public.is_pro(s) as is_pro
      from public.shops s left join auth.users u on u.id = s.owner_id
      where s.razorpay_subscription_id is not null) x), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(e order by e.received_at desc) from (
      select event, received_at from public.billing_events order by received_at desc limit 30) e), '[]'::jsonb)
  );
end $$;

-- ---------- spam watch ----------
create or replace function public.admin_spam()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'shops', coalesce((select jsonb_agg(x) from (
      select s.id as shop_id, s.name, s.created_at, s.blocked, count(o.id) as orders_day
      from public.orders o join public.shops s on s.id = o.shop_id
      where o.created_at > now() - interval '1 day'
      group by s.id order by count(o.id) desc limit 10) x), '[]'::jsonb),
    'networks', coalesce((select jsonb_agg(x) from (
      select r.ip_hash, count(*) as orders_day, max(r.created_at) as last_at,
        exists (select 1 from public.blocked_ips b where b.ip_hash = r.ip_hash) as blocked
      from public.order_rate r where r.created_at > now() - interval '1 day'
      group by r.ip_hash order by count(*) desc limit 10) x), '[]'::jsonb),
    'blocked_ips', coalesce((select jsonb_agg(b order by b.created_at desc) from public.blocked_ips b), '[]'::jsonb),
    'reports', coalesce((select jsonb_agg(x order by x.created_at desc) from (
      select r.id, r.shop_id, s.name, s.slug, r.reason, r.created_at, r.resolved
      from public.shop_reports r join public.shops s on s.id = r.shop_id
      order by r.resolved, r.created_at desc limit 50) x), '[]'::jsonb)
  );
end $$;

create or replace function public.admin_block_ip(p_hash text, p_block boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if coalesce(p_hash, '') !~ '^[0-9a-f]{32}$' then raise exception 'bad network id'; end if;
  if p_block then
    insert into public.blocked_ips (ip_hash, reason) values (p_hash, left(nullif(trim(p_reason), ''), 200))
    on conflict (ip_hash) do update set reason = excluded.reason;
  else
    delete from public.blocked_ips where ip_hash = p_hash;
  end if;
  insert into public.admin_log (admin_id, action, detail)
    values (auth.uid(), case when p_block then 'ip_blocked' else 'ip_unblocked' end, jsonb_build_object('ip', left(p_hash, 10), 'reason', p_reason));
end $$;

create or replace function public.admin_resolve_report(p_id bigint, p_resolved boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare v_shop uuid;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  update public.shop_reports set resolved = coalesce(p_resolved, true) where id = p_id returning shop_id into v_shop;
  if v_shop is null then raise exception 'Report not found'; end if;
  insert into public.admin_log (admin_id, action, shop_id, detail) values (auth.uid(), 'report_resolved', v_shop, jsonb_build_object('report', p_id));
end $$;

-- ---------- shop tools ----------
-- Old QR codes stop working; the owner's QR tab makes fresh ones (posters must be re-printed).
create or replace function public.admin_reset_qr(p_shop uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  delete from public.qr_links where shop_id = p_shop;
  get diagnostics n = row_count;
  insert into public.admin_log (admin_id, action, shop_id, detail) values (auth.uid(), 'qr_reset', p_shop, jsonb_build_object('codes', n));
  return n;
end $$;

create or replace function public.admin_edit_shop(p_shop uuid, p_name text default null, p_remove_logo boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select name into v_old from public.shops where id = p_shop;
  if not found then raise exception 'Shop not found'; end if;
  update public.shops set
    name = coalesce(nullif(trim(p_name), ''), name),
    logo_url = case when p_remove_logo then null else logo_url end
  where id = p_shop;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), 'shop_edited', p_shop, jsonb_build_object('old_name', v_old, 'new_name', nullif(trim(p_name), ''), 'logo_removed', p_remove_logo));
end $$;

-- ---------- settings ----------
create or replace function public.admin_set_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if coalesce(p->>'min_app_version', '') <> '' and (p->>'min_app_version') !~ '^\d+\.\d+\.\d+$' then
    raise exception 'bad version';
  end if;
  update public.app_settings set
    announcement     = left(nullif(trim(p->>'announcement'), ''), 300),
    announcement_hi  = left(nullif(trim(p->>'announcement_hi'), ''), 300),
    maintenance      = coalesce((p->>'maintenance')::boolean, false),
    maintenance_msg  = left(nullif(trim(p->>'maintenance_msg'), ''), 300),
    min_app_version  = nullif(trim(p->>'min_app_version'), ''),
    free_counter_limit = least(greatest(coalesce((p->>'free_counter_limit')::int, 0), 0), 20),
    updated_at = now()
  where id = 1;
  insert into public.admin_log (admin_id, action, detail) values (auth.uid(), 'settings', p);
  return public.get_app_settings();
end $$;

-- Log rows also show actions with no shop (settings, networks).
create or replace function public.admin_recent_log(p_limit int default 30)
returns table (created_at timestamptz, action text, shop_id uuid, shop_name text, detail jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return query
  select l.created_at, l.action, l.shop_id, s.name, l.detail
  from public.admin_log l left join public.shops s on s.id = l.shop_id
  order by l.created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 200);
end $$;

-- service role (admin-action Edge Function) writes its own log rows
grant insert on public.admin_log to service_role;

do $$
declare f text;
begin
  foreach f in array array[
    'admin_users(text, int, int)', 'admin_orders(text, text, int, int)', 'admin_payments()', 'admin_spam()',
    'admin_block_ip(text, boolean, text)', 'admin_resolve_report(bigint, boolean)', 'admin_reset_qr(uuid)',
    'admin_edit_shop(uuid, text, boolean)', 'admin_set_settings(jsonb)', 'admin_overview()', 'admin_recent_log(int)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
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
-- v16: third plan "Plus" (Rs 99/month, Rs 999/year): everything in Pro + no ads for the owner + unlimited counters.
-- Pro (Rs 49/month, Rs 539/year): dynamic QR, no ads for customers, passport sheet, up to 2 new counters.
-- Safe to run more than once.

alter table public.shops drop constraint if exists shops_plan_check;
alter table public.shops add constraint shops_plan_check check (plan in ('free', 'pro', 'plus'));

-- is_pro = any paid plan (Pro or Plus) and not expired. Everything gated on Pro keeps working for Plus.
create or replace function public.is_pro(s public.shops)
returns boolean language sql stable set search_path = public as $$
  select s.plan in ('pro', 'plus') and s.plan_expires_at is not null and s.plan_expires_at > now();
$$;

create or replace function public.is_plus(s public.shops)
returns boolean language sql stable set search_path = public as $$
  select s.plan = 'plus' and s.plan_expires_at is not null and s.plan_expires_at > now();
$$;
grant execute on function public.is_plus(public.shops) to anon, authenticated, service_role;

-- New counters a Pro shop may add (Plus: unlimited). Counters made earlier keep working.
create or replace function public.pro_counter_limit()
returns int language sql immutable as $$ select 2 $$;
grant execute on function public.pro_counter_limit() to anon, authenticated, service_role;

create or replace function public.counters_plan_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_shop public.shops;
  v_count int;
begin
  select * into v_shop from public.shops where id = new.shop_id for update;
  if not found then raise exception 'Shop not found'; end if;
  if public.is_plus(v_shop) then return new; end if;
  select count(*) into v_count from public.counters where shop_id = new.shop_id;
  if public.is_pro(v_shop) then
    if v_count >= public.pro_counter_limit() then
      raise exception 'More counters need the Plus plan';
    end if;
    return new;
  end if;
  if v_count >= public.free_counter_limit() then
    raise exception 'More counters need the Pro plan';
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';

-- Check: select plan, count(*) from public.shops group by plan;
