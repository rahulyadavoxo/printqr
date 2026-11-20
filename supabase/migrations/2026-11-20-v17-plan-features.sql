-- PrintQR v17 (2026-11-20): plan features.
--   Free / Pro / Plus
--   * File retention (files auto-delete):  1 hour / 24 hours / 7 days (the owner may pick shorter)
--   * Max order size:                      50 MB / 100 MB / 200 MB
--   * Orders per day:                      unlimited on every plan (only the 10-minute anti-spam limits stay)
--   * Order history visible:               7 days / 6 months / 1 year (older rows are hidden; rows over 1 year are deleted)
--   * No "Print by Receipto" branding, own colour + logo on customer pages, staff logins: Plus only
--   * Custom QR card design: Pro and Plus (saved in shops.qr_design)
--   * Shop timings (auto open/close per weekday), binding + lamination rates, "order ready" push: all plans
-- Needs v4 (pg_cron, pg_net, private.cron_tokens), v14 (push) and v16 (Plus).
-- Safe to run more than once. Paste the whole file in Supabase -> SQL Editor -> New query -> Run.
-- Then deploy the Edge Functions: push-new-order (and nothing else changed server-side).

-- ============ plan limits ============

create or replace function public.shop_tier(s public.shops)
returns text language sql stable set search_path = public as $$
  select case when public.is_plus(s) then 'plus' when public.is_pro(s) then 'pro' else 'free' end;
$$;

-- Longest time uploaded files may stay (hours).
create or replace function public.plan_file_hours(s public.shops)
returns int language sql stable set search_path = public as $$
  select case public.shop_tier(s) when 'plus' then 168 when 'pro' then 24 else 1 end;
$$;

-- Hours this shop's files really stay: the owner's choice, capped by the plan.
create or replace function public.shop_file_hours(s public.shops)
returns int language sql stable set search_path = public as $$
  select least(greatest(coalesce(s.auto_delete_hours, 24), 1), public.plan_file_hours(s));
$$;

-- Biggest order (all files together), bytes.
create or replace function public.plan_order_bytes(s public.shops)
returns bigint language sql stable set search_path = public as $$
  select case public.shop_tier(s) when 'plus' then 209715200::bigint when 'pro' then 104857600::bigint else 52428800::bigint end;
$$;

-- How far back the owner can see orders (days).
create or replace function public.plan_history_days(s public.shops)
returns int language sql stable set search_path = public as $$
  select case public.shop_tier(s) when 'plus' then 365 when 'pro' then 183 else 7 end;
$$;

create or replace function public.plan_history_start(s public.shops)
returns timestamptz language sql stable set search_path = public as $$
  select now() - make_interval(days => public.plan_history_days(s));
$$;

grant execute on function public.shop_tier(public.shops), public.plan_file_hours(public.shops), public.shop_file_hours(public.shops),
  public.plan_order_bytes(public.shops), public.plan_history_days(public.shops), public.plan_history_start(public.shops)
  to anon, authenticated, service_role;

-- ============ new columns ============

-- Plus: brand colour for the customer pages (#rrggbb). The logo is the shop photo (shops.logo_url, v6).
alter table public.shops add column if not exists brand_color text;
alter table public.shops drop constraint if exists shops_brand_color_check;
alter table public.shops add constraint shops_brand_color_check check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$');

-- Pro/Plus: QR card design {"template":"classic|dark|minimal","color":"#rrggbb","headline":"...","footer":"..."}
alter table public.shops add column if not exists qr_design jsonb not null default '{}'::jsonb;
alter table public.shops drop constraint if exists shops_qr_design_check;
alter table public.shops add constraint shops_qr_design_check check (jsonb_typeof(qr_design) = 'object' and pg_column_size(qr_design) < 2000);

-- Shop timings: {"enabled":true,"days":{"0":{"open":"09:00","close":"21:00","closed":false}, ... "6":{...}}}  (0 = Sunday, India time)
alter table public.shops add column if not exists hours jsonb not null default '{}'::jsonb;
alter table public.shops add column if not exists hours_applied text;  -- last state the schedule set ('open' / 'closed'); not owner-editable
alter table public.shops drop constraint if exists shops_hours_check;
alter table public.shops add constraint shops_hours_check check (jsonb_typeof(hours) = 'object' and pg_column_size(hours) < 3000);

grant update (brand_color, qr_design, hours) on public.shops to authenticated;

-- Binding / lamination per file (rates.binding = per copy, rates.lamination = per sheet).
alter table public.order_files add column if not exists binding boolean not null default false;
alter table public.order_files add column if not exists lamination boolean not null default false;

-- ============ price of one printed file ============
-- pages x copies x page rate (colour / b&w, one / both sides)
-- + binding: copies x rates.binding
-- + lamination: sheets x copies x rates.lamination (sheets = pages, or pages / 2 rounded up when both sides)
create or replace function public.file_price(p_rates jsonb, p_pages int, p_copies int, p_color boolean, p_duplex boolean,
  p_binding boolean default false, p_lamination boolean default false)
returns numeric language sql immutable as $$
  select round(
    p_pages * p_copies * coalesce((p_rates ->> (
      case when p_color then 'color' else 'bw' end || case when p_duplex then '_double' else '_single' end))::numeric, 0)
    + case when p_binding then p_copies * coalesce((p_rates ->> 'binding')::numeric, 0) else 0 end
    + case when p_lamination then (case when p_duplex then ceil(p_pages / 2.0) else p_pages end) * p_copies
        * coalesce((p_rates ->> 'lamination')::numeric, 0) else 0 end
  , 2);
$$;
grant execute on function public.file_price(jsonb, int, int, boolean, boolean, boolean, boolean) to anon, authenticated, service_role;

-- ============ create_order: plan order size, binding, lamination ============
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
  v_binding boolean;
  v_lam boolean;
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
  v_max bigint;
  v_day_start timestamptz := (date_trunc('day', now() at time zone 'Asia/Kolkata')) at time zone 'Asia/Kolkata';
begin
  select * into v_shop from public.shops where slug = p_slug for update;
  if not found then raise exception 'Shop not found'; end if;
  if not v_shop.is_open then raise exception 'Shop is closed right now'; end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 then
    raise exception 'No files';
  end if;
  if jsonb_array_length(p_files) > 20 then raise exception 'Max 20 files per order'; end if;

  -- Anti-spam (per 10 minutes, not per day: orders per day are unlimited on every plan).
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

  -- File checks: only print-able types, real sizes, each file up to 50 MB, the order up to the plan's size.
  v_max := public.plan_order_bytes(v_shop);
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
  if v_bytes > v_max then raise exception 'This shop accepts up to % MB per order', v_max / 1048576; end if;
  if v_ip is not null then insert into public.order_rate (ip_hash) values (v_ip); end if;
  v_pro := public.is_pro(v_shop);
  if not v_pro and exists (select 1 from jsonb_array_elements(p_files) x where x->>'kind' = 'passport') then
    raise exception 'Passport photo sheet is not available at this shop';
  end if;

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
    v_binding := false;
    v_lam := false;
    if v_kind = 'passport' then
      v_photos := greatest(1, least(300, coalesce((v_f->>'photos')::int, 8)));
      v_pages := ceil(v_photos / 30.0)::int;
      v_total_pages := v_pages;
      v_copies := 1;
      v_color := true;
      v_duplex := false;
      v_range := null;
      v_rate := coalesce((v_shop.rates ->> 'passport_sheet')::numeric, 40);
      v_price := round(v_pages * v_copies * v_rate, 2);
    else
      v_photos := null;
      v_pages := greatest(1, least(2000, coalesce((v_f->>'pages_to_print')::int, 1)));
      v_total_pages := greatest(1, least(2000, coalesce((v_f->>'total_pages')::int, 1)));
      v_copies := greatest(1, least(100, coalesce((v_f->>'copies')::int, 1)));
      v_color := coalesce((v_f->>'color')::boolean, false);
      v_duplex := coalesce((v_f->>'duplex')::boolean, false);
      -- Extras only when the shop has a rate for them (0 / missing = not offered).
      v_binding := coalesce((v_f->>'binding')::boolean, false) and coalesce((v_shop.rates ->> 'binding')::numeric, 0) > 0;
      v_lam := coalesce((v_f->>'lamination')::boolean, false) and coalesce((v_shop.rates ->> 'lamination')::numeric, 0) > 0;
      v_range := nullif(left(v_f->>'page_range', 60), '');
      v_price := public.file_price(v_shop.rates, v_pages, v_copies, v_color, v_duplex, v_binding, v_lam);
    end if;
    v_total := v_total + v_price;
    v_path := v_shop.id::text || '/' || v_order.id::text || '/' || v_i::text || '-' ||
      left(regexp_replace(coalesce(v_f->>'name','file'), '[^A-Za-z0-9._-]', '_', 'g'), 80);
    v_paths := v_paths || v_path;
    insert into public.order_files (order_id, shop_id, storage_path, file_name, mime, size_bytes,
        total_pages, page_range, pages_to_print, copies, color, duplex, price, item_kind, photos, binding, lamination)
      values (v_order.id, v_shop.id, v_path, left(coalesce(v_f->>'name','file'), 200), v_f->>'mime',
        (v_f->>'size')::bigint, v_total_pages, v_range, v_pages, v_copies, v_color, v_duplex, v_price,
        v_kind, v_photos, v_binding, v_lam);
  end loop;

  update public.orders set total = v_total where id = v_order.id;

  return query select v_order.id, v_order.access_key, v_token, v_shop.id, v_total, v_paths;
end $$;
grant execute on function public.create_order(text, text, text, jsonb, uuid) to anon, authenticated;

-- Server page count (v11) now keeps binding + lamination in the price.
create or replace function public.finalize_order_counted(p_order_id uuid, p_key uuid, p_counts jsonb)
returns table (total numeric, changed int)
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_shop public.shops;
  v_f public.order_files;
  v_n int;
  v_changed int := 0;
  v_missing int;
  v_total numeric(10,2);
begin
  select * into v_order from public.orders o
    where o.id = p_order_id and o.access_key = p_key and o.status = 'uploading' for update;
  if not found then raise exception 'Order not found'; end if;
  select * into v_shop from public.shops s where s.id = v_order.shop_id;

  for v_f in select * from public.order_files f
      where f.order_id = v_order.id and f.item_kind = 'print' and f.mime = 'application/pdf' loop
    v_n := (p_counts ->> v_f.id::text)::int;
    if v_n is null or v_n < 1 then raise exception 'Could not read the pages of %', left(v_f.file_name, 60); end if;
    if v_n > 2000 then raise exception 'A PDF can have up to 2000 pages'; end if;
    if v_n <> v_f.pages_to_print then
      update public.order_files set pages_to_print = v_n, total_pages = v_n, page_range = null,
          price = public.file_price(v_shop.rates, v_n, v_f.copies, v_f.color, v_f.duplex, v_f.binding, v_f.lamination)
        where id = v_f.id;
      v_changed := v_changed + 1;
    end if;
  end loop;

  select count(*) into v_missing from public.order_files f
    where f.order_id = v_order.id and not exists (
      select 1 from storage.objects so
      where so.bucket_id = 'uploads' and so.name = f.storage_path
        and (so.metadata->>'size')::bigint = f.size_bytes);
  if v_missing > 0 then raise exception 'Some files did not upload completely. Please try again.'; end if;

  select coalesce(sum(f.price), 0) into v_total from public.order_files f where f.order_id = v_order.id;
  update public.orders set total = v_total, status = 'received', updated_at = now() where id = v_order.id;
  return query select v_total::numeric, v_changed;
end $$;
revoke all on function public.finalize_order_counted(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_order_counted(uuid, uuid, jsonb) to service_role;

-- ============ customer pages ============

-- Upload page. Plus shops also send their logo + colour (shown instead of the PrintQR branding).
drop function if exists public.get_shop_public(text);
create function public.get_shop_public(p_slug text)
returns table (id uuid, name text, address text, is_open boolean, rates jsonb, upi_id text, is_pro boolean,
  is_plus boolean, logo_url text, brand_color text, max_order_mb int, file_hours int, hours jsonb)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.address, s.is_open,
    case when public.is_pro(s) then jsonb_build_object('passport_sheet', 40) || s.rates
         else s.rates - 'passport_sheet' end,
    s.upi_id, public.is_pro(s),
    public.is_plus(s),
    case when public.is_plus(s) then s.logo_url end,
    case when public.is_plus(s) then s.brand_color end,
    (public.plan_order_bytes(s) / 1048576)::int,
    public.shop_file_hours(s),
    case when coalesce((s.hours->>'enabled')::boolean, false) then s.hours end
  from public.shops s where s.slug = p_slug and not s.blocked;
$$;
grant execute on function public.get_shop_public(text) to anon, authenticated;

-- Status page: + when the files auto-delete, and the Plus branding.
drop function if exists public.get_order_status(uuid, uuid);
create function public.get_order_status(p_order_id uuid, p_key uuid)
returns table (token int, status text, total numeric, created_at timestamptz, shop_name text, upi_id text, file_count int,
  files_deleted boolean, files_expire_at timestamptz, is_plus boolean, logo_url text, brand_color text)
language sql stable security definer set search_path = public as $$
  select o.token, o.status, o.total, o.created_at, s.name, s.upi_id,
    (select count(*)::int from public.order_files f where f.order_id = o.id),
    o.files_deleted,
    o.created_at + make_interval(hours => public.shop_file_hours(s)),
    public.is_plus(s),
    case when public.is_plus(s) then s.logo_url end,
    case when public.is_plus(s) then s.brand_color end
  from public.orders o join public.shops s on s.id = o.shop_id
  where o.id = p_order_id and o.access_key = p_key;
$$;
grant execute on function public.get_order_status(uuid, uuid) to anon, authenticated;

-- ============ file retention (cleanup job, every 15 min, v4) ============
create or replace function public.cleanup_candidates()
returns table (order_id uuid, status text, paths text[])
language sql stable security definer set search_path = public as $$
  select o.id, o.status, array(select f.storage_path from public.order_files f where f.order_id = o.id)
  from public.orders o join public.shops s on s.id = o.shop_id
  where o.files_deleted = false and (
    o.created_at < now() - make_interval(hours => public.shop_file_hours(s))
    or (o.status = 'uploading' and o.created_at < now() - interval '1 hour')
  )
  limit 500;
$$;
revoke all on function public.cleanup_candidates() from public, anon, authenticated;
grant execute on function public.cleanup_candidates() to service_role;

-- ============ order history window ============
-- Owners see orders from the last 7 days (Free) / 6 months (Pro) / 1 year (Plus).
drop policy if exists "owner reads orders" on public.orders;
create policy "owner reads orders" on public.orders for select to authenticated
  using (exists (select 1 from public.shops s
    where s.id = orders.shop_id and s.owner_id = auth.uid() and orders.created_at >= public.plan_history_start(s)));

drop policy if exists "owner reads files" on public.order_files;
create policy "owner reads files" on public.order_files for select to authenticated
  using (exists (select 1 from public.orders o join public.shops s on s.id = o.shop_id
    where o.id = order_files.order_id and s.owner_id = auth.uid() and o.created_at >= public.plan_history_start(s)));

-- Rows older than the longest window (1 year) are deleted once their files are gone. Runs daily.
create or replace function public.purge_old_orders()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.orders where created_at < now() - interval '366 days' and files_deleted;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.purge_old_orders() from public, anon, authenticated;

-- ============ staff logins (Plus) ============
create table if not exists public.shop_staff (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) <= 200 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (shop_id, email)
);
create index if not exists shop_staff_user on public.shop_staff (user_id);
create index if not exists shop_staff_email on public.shop_staff (email);
alter table public.shop_staff enable row level security;
revoke all on public.shop_staff from public, anon, authenticated;
grant select, delete on public.shop_staff to authenticated;
grant insert (shop_id, email) on public.shop_staff to authenticated;
grant all on public.shop_staff to service_role;

drop policy if exists "owner reads staff" on public.shop_staff;
create policy "owner reads staff" on public.shop_staff for select to authenticated
  using (shop_id in (select id from public.shops where owner_id = auth.uid()));
drop policy if exists "owner adds staff" on public.shop_staff;
create policy "owner adds staff" on public.shop_staff for insert to authenticated
  with check (shop_id in (select id from public.shops where owner_id = auth.uid()));
drop policy if exists "owner removes staff" on public.shop_staff;
create policy "owner removes staff" on public.shop_staff for delete to authenticated
  using (shop_id in (select id from public.shops where owner_id = auth.uid()));

create or replace function public.shop_staff_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_shop public.shops;
  v_owner_email text;
begin
  new.email := lower(trim(new.email));
  new.user_id := null;
  new.accepted_at := null;
  select * into v_shop from public.shops where id = new.shop_id for update;
  if not found then raise exception 'Shop not found'; end if;
  if not public.is_plus(v_shop) then raise exception 'Staff login needs the Plus plan'; end if;
  if (select count(*) from public.shop_staff where shop_id = new.shop_id) >= 10 then
    raise exception 'Up to 10 staff per shop';
  end if;
  select lower(email) into v_owner_email from auth.users where id = v_shop.owner_id;
  if v_owner_email = new.email then raise exception 'This is your own login'; end if;
  return new;
end $$;
drop trigger if exists shop_staff_guard on public.shop_staff;
create trigger shop_staff_guard before insert on public.shop_staff
  for each row execute function public.shop_staff_guard();

-- Shops this login works at as staff (only while the shop is on Plus and not blocked).
create or replace function public.staff_shop_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select st.shop_id from public.shop_staff st join public.shops s on s.id = st.shop_id
  where st.user_id = auth.uid() and public.is_plus(s) and not s.blocked;
$$;
revoke all on function public.staff_shop_ids() from public, anon;
grant execute on function public.staff_shop_ids() to authenticated;

-- Called by the dashboard when the login has no shop of its own: links a pending invite for this
-- (confirmed) email and returns the shop the login works at, or null.
create or replace function public.my_staff_shop()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_confirmed boolean;
  r jsonb;
begin
  if auth.uid() is null then return null; end if;
  select lower(u.email), u.email_confirmed_at is not null into v_email, v_confirmed from auth.users u where u.id = auth.uid();
  if v_email is not null and v_confirmed then
    update public.shop_staff set user_id = auth.uid(), accepted_at = coalesce(accepted_at, now())
      where email = v_email and user_id is null;
  end if;
  select jsonb_build_object(
      'id', s.id, 'owner_id', s.owner_id, 'name', s.name, 'slug', s.slug, 'address', s.address,
      'phone', null, 'upi_id', null, 'is_open', s.is_open, 'rates', s.rates,
      'auto_delete_hours', s.auto_delete_hours, 'created_at', s.created_at, 'logo_url', s.logo_url,
      'plan', s.plan, 'plan_expires_at', s.plan_expires_at, 'blocked', s.blocked,
      'staff', true, 'staff_active', public.is_plus(s) and not s.blocked)
    into r
    from public.shop_staff st join public.shops s on s.id = st.shop_id
    where st.user_id = auth.uid()
    order by st.accepted_at nulls last
    limit 1;
  return r;
end $$;
revoke all on function public.my_staff_shop() from public, anon;
grant execute on function public.my_staff_shop() to authenticated;

-- Staff: orders (last year), their files, counters (for the filter), and the uploaded files. Nothing else.
drop policy if exists "staff reads orders" on public.orders;
create policy "staff reads orders" on public.orders for select to authenticated
  using (shop_id in (select public.staff_shop_ids()) and created_at >= now() - interval '365 days');
drop policy if exists "staff updates orders" on public.orders;
create policy "staff updates orders" on public.orders for update to authenticated
  using (shop_id in (select public.staff_shop_ids()))
  with check (shop_id in (select public.staff_shop_ids()));
drop policy if exists "staff reads files" on public.order_files;
create policy "staff reads files" on public.order_files for select to authenticated
  using (shop_id in (select public.staff_shop_ids()));
drop policy if exists "staff reads counters" on public.counters;
create policy "staff reads counters" on public.counters for select to authenticated
  using (shop_id in (select public.staff_shop_ids()));
drop policy if exists "staff reads uploads" on storage.objects;
create policy "staff reads uploads" on storage.objects for select to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] in (select x::text from public.staff_shop_ids() x));
drop policy if exists "staff deletes uploads" on storage.objects;
create policy "staff deletes uploads" on storage.objects for delete to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] in (select x::text from public.staff_shop_ids() x));

-- New-order push also reaches staff phones (Plus).
create or replace function public.notify_new_order()
returns trigger language plpgsql security definer set search_path = public, private as $$
begin
  if new.status = 'received' and (tg_op = 'INSERT' or old.status = 'uploading') then
    if exists (select 1 from public.push_tokens p join public.shops s on s.owner_id = p.owner_id where s.id = new.shop_id)
       or exists (select 1 from public.push_tokens p join public.shop_staff st on st.user_id = p.owner_id
                  join public.shops s on s.id = st.shop_id where st.shop_id = new.shop_id and public.is_plus(s)) then
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
  return new;
end $$;

-- ============ shop timings (all plans) ============
-- 'open' / 'closed' for the schedule at p_at (India time), null when there is no schedule.
create or replace function public.shop_hours_state(p_hours jsonb, p_at timestamptz default now())
returns text language plpgsql stable set search_path = public as $$
declare
  v_local timestamp := p_at at time zone 'Asia/Kolkata';
  v_dow int := extract(dow from (p_at at time zone 'Asia/Kolkata'))::int;
  v_t time := (p_at at time zone 'Asia/Kolkata')::time;
  v_day jsonb;
  v_prev jsonb;
  v_o time;
  v_c time;
begin
  if p_hours is null or not coalesce((p_hours->>'enabled')::boolean, false) then return null; end if;
  -- Still open from yesterday's late shift (closes after midnight)?
  v_prev := p_hours->'days'->(((v_dow + 6) % 7)::text);
  if v_prev is not null and not coalesce((v_prev->>'closed')::boolean, false) then
    v_o := (v_prev->>'open')::time;
    v_c := (v_prev->>'close')::time;
    if v_c <= v_o and v_t < v_c then return 'open'; end if;
  end if;
  v_day := p_hours->'days'->(v_dow::text);
  if v_day is null or coalesce((v_day->>'closed')::boolean, false) then return 'closed'; end if;
  v_o := (v_day->>'open')::time;
  v_c := (v_day->>'close')::time;
  if v_o is null or v_c is null then return 'closed'; end if;
  if v_c > v_o then
    return case when v_t >= v_o and v_t < v_c then 'open' else 'closed' end;
  end if;
  return case when v_t >= v_o then 'open' else 'closed' end;
exception when others then
  return null;
end $$;
grant execute on function public.shop_hours_state(jsonb, timestamptz) to anon, authenticated, service_role;

-- Saving new timings lets the schedule apply on its next run.
create or replace function public.shops_hours_changed()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.hours is distinct from old.hours then new.hours_applied := null; end if;
  return new;
end $$;
drop trigger if exists shops_hours_changed on public.shops;
create trigger shops_hours_changed before update of hours on public.shops
  for each row execute function public.shops_hours_changed();

-- Opens / closes shops at their scheduled times. The owner can still switch by hand in between;
-- the schedule only acts when its own state changes (opening time, closing time).
create or replace function public.apply_shop_hours()
returns int language plpgsql security definer set search_path = public as $$
declare
  n int := 0;
  r record;
  v_state text;
begin
  for r in select s.id, s.hours, s.hours_applied from public.shops s
      where coalesce((s.hours->>'enabled')::boolean, false) loop
    v_state := public.shop_hours_state(r.hours);
    if v_state is not null and v_state is distinct from r.hours_applied then
      update public.shops set is_open = (v_state = 'open'), hours_applied = v_state where id = r.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.apply_shop_hours() from public, anon, authenticated;

-- ============ "order ready" push for customers (all plans) ============
create table if not exists public.order_push (
  order_id uuid not null references public.orders(id) on delete cascade,
  token text not null,
  created_at timestamptz not null default now(),
  primary key (order_id, token)
);
create index if not exists order_push_time on public.order_push (created_at);
alter table public.order_push enable row level security;  -- no policies: only the functions below
revoke all on public.order_push from public, anon, authenticated;
grant all on public.order_push to service_role;

create or replace function public.register_order_push(p_order_id uuid, p_key uuid, p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_token is null or length(p_token) < 20 or length(p_token) > 4096 then raise exception 'Bad push token'; end if;
  if not exists (select 1 from public.orders o where o.id = p_order_id and o.access_key = p_key
                 and o.status in ('uploading', 'received', 'printing')) then
    raise exception 'Order not found';
  end if;
  delete from public.order_push where created_at < now() - interval '3 days';
  insert into public.order_push (order_id, token) values (p_order_id, p_token) on conflict do nothing;
  delete from public.order_push where order_id = p_order_id
    and token not in (select token from public.order_push where order_id = p_order_id order by created_at desc limit 3);
end $$;
revoke all on function public.register_order_push(uuid, uuid, text) from public;
grant execute on function public.register_order_push(uuid, uuid, text) to anon, authenticated;

create or replace function public.notify_order_ready()
returns trigger language plpgsql security definer set search_path = public, private as $$
begin
  if new.status = 'ready' and old.status is distinct from 'ready'
     and exists (select 1 from public.order_push p where p.order_id = new.id) then
    perform net.http_post(
      url := 'https://asqgdgzxkdksoikmffmd.supabase.co/functions/v1/push-new-order',
      body := jsonb_build_object('order_id', new.id, 'kind', 'ready'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-token', (select token from private.cron_tokens where name = 'push')
      ),
      timeout_milliseconds := 10000
    );
  end if;
  return new;
exception when others then
  return new;  -- a notification problem must never block the status change
end $$;
drop trigger if exists orders_ready_notify on public.orders;
create trigger orders_ready_notify after update of status on public.orders
  for each row execute function public.notify_order_ready();

-- ============ schedules ============
do $$
begin
  if exists (select 1 from cron.job where jobname = 'printqr-shop-hours') then perform cron.unschedule('printqr-shop-hours'); end if;
  if exists (select 1 from cron.job where jobname = 'printqr-purge-orders') then perform cron.unschedule('printqr-purge-orders'); end if;
end $$;
select cron.schedule('printqr-shop-hours', '*/5 * * * *', $job$ select public.apply_shop_hours(); $job$);
-- 03:30 India time every day
select cron.schedule('printqr-purge-orders', '0 22 * * *', $job$ select public.purge_old_orders(); $job$);

notify pgrst, 'reload schema';

-- Checks:
--   select name, public.shop_tier(s), public.shop_file_hours(s), public.plan_order_bytes(s) / 1048576 as mb from public.shops s limit 5;
--   select jobname, schedule from cron.job where jobname like 'printqr-%';
