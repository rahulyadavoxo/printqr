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
