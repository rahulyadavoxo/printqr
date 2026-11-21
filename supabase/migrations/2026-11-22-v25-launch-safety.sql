-- PrintQR v25 migration (2026-11-22): launch safety (P0 fixes 2, 3, 4, 5, 8, 10). Safe to run more than once. Needs v24.
--
-- 1. Files of orders not printed yet are kept: Received / Printing orders keep their files until the shop
--    moves them on (or at most 48 hours, or the plan's time if longer). Free plan: 3 hours (was 1).
--    Unfinished uploads are removed after 35 minutes (was 1 hour).
-- 2. Storage budgets: per shop (Free 150 MB, Pro / Plus 500 MB of files not yet deleted) and for the whole
--    service (700 MB, below the 1 GB Supabase Free storage). Change them in app_settings.
-- 3. Bot check only when needed: create_order(..., p_pass) asks for a Turnstile pass (upload-pass function)
--    when one network sent 3+ orders or one shop got 20+ orders in 10 minutes. app_settings.order_captcha:
--    'auto' (default) / 'always' / 'off'.
-- 4. "Block sender": the shop owner can block the network an order came from (and cancel its open orders).
--    The network id (a hash) is kept in order_senders, which shop owners cannot read.
-- 5. finalize-order may run at most 5 times per order (finalize_begin).
-- 6. ops_events + ops_health() for the "Health check" GitHub workflow (alerts, storage / database size).

-- ============ settings ============
alter table public.app_settings add column if not exists order_captcha text not null default 'auto';
alter table public.app_settings add column if not exists storage_budget_mb int not null default 700;
alter table public.app_settings add column if not exists shop_storage_free_mb int not null default 150;
alter table public.app_settings add column if not exists shop_storage_paid_mb int not null default 500;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'app_settings_order_captcha_check') then
    alter table public.app_settings add constraint app_settings_order_captcha_check check (order_captcha in ('off', 'auto', 'always'));
  end if;
end $$;

create or replace function public.storage_budget_bytes()
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce((select storage_budget_mb from public.app_settings where id = 1), 700)::bigint * 1048576;
$$;
revoke all on function public.storage_budget_bytes() from public, anon, authenticated;

create or replace function public.shop_storage_bytes(s public.shops)
returns bigint language sql stable security definer set search_path = public as $$
  select (case when public.shop_tier(s) = 'free'
    then coalesce((select shop_storage_free_mb from public.app_settings where id = 1), 150)
    else coalesce((select shop_storage_paid_mb from public.app_settings where id = 1), 500) end)::bigint * 1048576;
$$;
revoke all on function public.shop_storage_bytes(public.shops) from public, anon, authenticated;

-- ============ 1. retention ============
create or replace function public.plan_file_hours(s public.shops)
returns int language sql stable set search_path = public as $$
  select case public.shop_tier(s) when 'plus' then 168 when 'pro' then 24 else 3 end;
$$;

create or replace function public.cleanup_candidates()
returns table (order_id uuid, status text, paths text[])
language sql stable security definer set search_path = public as $$
  select o.id, o.status, array(select f.storage_path from public.order_files f where f.order_id = o.id)
  from public.orders o join public.shops s on s.id = o.shop_id
  where o.files_deleted = false and (
    (o.status = 'uploading' and o.created_at < now() - interval '35 minutes')
    or (o.status in ('ready', 'done', 'cancelled') and o.created_at < now() - make_interval(hours => public.shop_file_hours(s)))
    or (o.status in ('received', 'printing')
        and o.created_at < now() - make_interval(hours => greatest(public.shop_file_hours(s), 48)))
  )
  limit 500;
$$;
revoke all on function public.cleanup_candidates() from public, anon, authenticated;
grant execute on function public.cleanup_candidates() to service_role;

create index if not exists orders_live_files_idx on public.orders (shop_id) where files_deleted = false;

-- ============ 3 + 4. tables ============
create table if not exists public.upload_pass (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
alter table public.upload_pass enable row level security;
revoke all on public.upload_pass from anon, authenticated;
grant select, insert, delete on public.upload_pass to service_role;

create table if not exists public.order_senders (
  order_id uuid primary key references public.orders (id) on delete cascade,
  shop_id uuid not null references public.shops (id) on delete cascade,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists order_senders_shop_ip_idx on public.order_senders (shop_id, ip_hash);
alter table public.order_senders enable row level security;
revoke all on public.order_senders from anon, authenticated;
grant select on public.order_senders to service_role;

create table if not exists public.shop_blocked_senders (
  shop_id uuid not null references public.shops (id) on delete cascade,
  ip_hash text not null,
  created_at timestamptz not null default now(),
  primary key (shop_id, ip_hash)
);
alter table public.shop_blocked_senders enable row level security;
revoke all on public.shop_blocked_senders from anon, authenticated;
grant select on public.shop_blocked_senders to service_role;

-- ============ create_order with p_pass ============
-- The old 5-argument version is replaced (old apps still call it with 4 or 5 arguments: p_pass has a default).
drop function if exists public.create_order(text, text, text, jsonb, uuid);
create or replace function public.create_order(p_slug text, p_customer_name text, p_note text, p_files jsonb, p_counter uuid default null,
  p_pass uuid default null)
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
  v_mode text;
  v_live_shop bigint;
  v_live_all bigint;
  v_cap_shop bigint;
  v_cap_all bigint;
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

  -- v25: the shop owner blocked this network ("Block sender" on an order).
  if v_ip is not null and exists (select 1 from public.shop_blocked_senders b where b.shop_id = v_shop.id and b.ip_hash = v_ip) then
    raise exception 'This shop is not accepting orders from your network.';
  end if;

  -- v25: bot check only when an order looks automated ('auto'), always ('always') or never ('off').
  -- 'captcha_required' makes the upload page show the Turnstile check, get a pass from upload-pass and retry.
  v_mode := coalesce((select order_captcha from public.app_settings where id = 1), 'auto');
  if v_mode = 'always' or (v_mode = 'auto' and (
       (v_ip is not null and (select count(*) from public.order_rate r where r.ip_hash = v_ip and r.created_at > now() - interval '10 minutes') >= 3)
       or (select count(*) from public.orders o where o.shop_id = v_shop.id and o.created_at > now() - interval '10 minutes') >= 20)) then
    if p_pass is null then raise exception 'captcha_required'; end if;
    delete from public.upload_pass up where up.created_at < now() - interval '1 hour';
    delete from public.upload_pass up where up.id = p_pass and up.created_at > now() - interval '10 minutes';
    if not found then raise exception 'captcha_required'; end if;
  end if;

  -- File checks: only print-able types, real sizes, each file up to 50 MB, the order up to the plan's size.
  v_max := public.plan_order_bytes(v_shop);
  for v_f in select * from jsonb_array_elements(p_files) loop
    v_ext := lower(substring(coalesce(v_f->>'name', '') from '\.([A-Za-z0-9]+)$'));
    v_mime := public.upload_mime_for(v_ext);
    if v_mime is null or coalesce(v_f->>'mime', '') <> v_mime then
      raise exception 'File type not allowed: %. Send PDF, photo, Word, Excel or PowerPoint files.', left(coalesce(v_f->>'name', 'file'), 60);
    end if;
    if v_f->>'kind' = 'idcard' and v_mime <> 'application/pdf' then
      raise exception 'File type not allowed: %. Send PDF, photo, Word, Excel or PowerPoint files.', left(coalesce(v_f->>'name', 'file'), 60);
    end if;
    v_size := coalesce((v_f->>'size')::bigint, 0);
    if v_size < 1 or v_size > 52428800 then raise exception 'Each file must be under 50 MB'; end if;
    v_bytes := v_bytes + v_size;
  end loop;
  if v_bytes > v_max then raise exception 'This shop accepts up to % MB per order', v_max / 1048576; end if;

  -- v25: storage budgets (files not yet auto-deleted), so a flood of uploads cannot fill the storage for everyone.
  v_cap_shop := public.shop_storage_bytes(v_shop);
  v_cap_all := public.storage_budget_bytes();
  select coalesce(sum(f.size_bytes), 0) into v_live_shop
    from public.order_files f join public.orders o on o.id = f.order_id
    where o.shop_id = v_shop.id and o.files_deleted = false;
  if v_live_shop + v_bytes > v_cap_shop then
    raise exception 'This shop''s file space is full right now. Please ask the shop to finish or clear old orders, then try again.';
  end if;
  select coalesce(sum(f.size_bytes), 0) into v_live_all
    from public.order_files f join public.orders o on o.id = f.order_id
    where o.files_deleted = false;
  if v_live_all + v_bytes > v_cap_all then
    raise exception 'Uploads are paused for a short while because the service is very busy. Please try again later.';
  end if;
  if v_ip is not null then insert into public.order_rate (ip_hash) values (v_ip); end if;
  v_pro := public.is_pro(v_shop);
  if not v_pro and exists (select 1 from jsonb_array_elements(p_files) x where x->>'kind' = 'passport') then
    raise exception 'Passport photo sheet is not available at this shop';
  end if;
  if not v_pro and exists (select 1 from jsonb_array_elements(p_files) x where x->>'kind' = 'idcard') then
    raise exception 'ID card sheet is not available at this shop';
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
  if v_ip is not null then
    insert into public.order_senders (order_id, shop_id, ip_hash) values (v_order.id, v_shop.id, v_ip);
  end if;

  for v_f in select * from jsonb_array_elements(p_files) loop
    v_i := v_i + 1;
    v_kind := case when v_f->>'kind' in ('passport', 'idcard') then v_f->>'kind' else 'print' end;
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
    elsif v_kind = 'idcard' then
      -- One A4 page (front above back). finalize-order checks the PDF really has one page.
      v_photos := null;
      v_pages := 1;
      v_total_pages := 1;
      v_copies := greatest(1, least(100, coalesce((v_f->>'copies')::int, 1)));
      v_color := coalesce((v_f->>'color')::boolean, true);
      v_duplex := false;
      v_range := null;
      v_rate := coalesce((v_shop.rates ->> 'idcard_sheet')::numeric, 20);
      v_price := round(v_copies * v_rate, 2);
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
grant execute on function public.create_order(text, text, text, jsonb, uuid, uuid) to anon, authenticated;

-- ============ 4. Block sender (owner or staff of the order's shop) ============
create or replace function public.can_manage_shop(p_shop uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shops s where s.id = p_shop and s.owner_id = auth.uid())
      or p_shop in (select public.staff_shop_ids());
$$;
revoke all on function public.can_manage_shop(uuid) from public, anon;
grant execute on function public.can_manage_shop(uuid) to authenticated;

-- Blocks the order's network for this shop and cancels its open orders. Returns how many were cancelled
-- (-1 when the order has no network id, e.g. a reorder or an old order).
create or replace function public.block_order_sender(p_order_id uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_shop uuid;
  v_ip text;
  v_n int;
begin
  select o.shop_id into v_shop from public.orders o where o.id = p_order_id;
  if v_shop is null or not public.can_manage_shop(v_shop) then raise exception 'not allowed'; end if;
  select s.ip_hash into v_ip from public.order_senders s where s.order_id = p_order_id;
  if v_ip is null then return -1; end if;
  insert into public.shop_blocked_senders (shop_id, ip_hash) values (v_shop, v_ip) on conflict do nothing;
  update public.orders o set status = 'cancelled', updated_at = now()
    where o.shop_id = v_shop and o.status in ('received', 'printing')
      and o.id in (select s.order_id from public.order_senders s where s.shop_id = v_shop and s.ip_hash = v_ip);
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.block_order_sender(uuid) from public, anon;
grant execute on function public.block_order_sender(uuid) to authenticated;

create or replace function public.blocked_sender_count(p_shop uuid)
returns int language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_manage_shop(p_shop) then raise exception 'not allowed'; end if;
  return (select count(*) from public.shop_blocked_senders b where b.shop_id = p_shop);
end $$;
revoke all on function public.blocked_sender_count(uuid) from public, anon;
grant execute on function public.blocked_sender_count(uuid) to authenticated;

create or replace function public.unblock_all_senders(p_shop uuid)
returns int language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not exists (select 1 from public.shops s where s.id = p_shop and s.owner_id = auth.uid()) then raise exception 'not allowed'; end if;
  delete from public.shop_blocked_senders b where b.shop_id = p_shop;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.unblock_all_senders(uuid) from public, anon;
grant execute on function public.unblock_all_senders(uuid) to authenticated;

-- ============ 5. finalize attempts ============
alter table public.orders add column if not exists finalize_attempts int not null default 0;

create or replace function public.finalize_begin(p_order_id uuid, p_key uuid)
returns int language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update public.orders o set finalize_attempts = o.finalize_attempts + 1
    where o.id = p_order_id and o.access_key = p_key and o.status = 'uploading'
      and o.created_at > now() - interval '35 minutes'
    returning o.finalize_attempts into v_n;
  return coalesce(v_n, 0);
end $$;
revoke all on function public.finalize_begin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_begin(uuid, uuid) to service_role;

-- ============ 6. monitoring ============
create table if not exists public.ops_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  source text not null,
  level text not null default 'error',
  message text not null
);
create index if not exists ops_events_created_idx on public.ops_events (created_at);
alter table public.ops_events enable row level security;
revoke all on public.ops_events from anon, authenticated;
grant select, insert, delete on public.ops_events to service_role;

-- What the Health check workflow reads (service role only). p_since_min: how far back to look for events.
create or replace function public.ops_health(p_since_min int default 20)
returns jsonb language plpgsql volatile security definer set search_path = public, storage, cron as $$
declare
  v_events jsonb;
  v_cron int := 0;
begin
  select coalesce(jsonb_agg(jsonb_build_object('source', x.source, 'level', x.level, 'n', x.n, 'last', x.last)), '[]'::jsonb)
    into v_events
    from (select e.source, e.level, count(*) as n, (array_agg(e.message order by e.id desc))[1] as last
          from public.ops_events e where e.created_at > now() - make_interval(mins => p_since_min)
          group by e.source, e.level) x;
  begin
    select count(*) into v_cron from cron.job_run_details d
      where d.status = 'failed' and d.start_time > now() - make_interval(mins => p_since_min);
  exception when others then v_cron := 0;
  end;
  delete from public.ops_events where created_at < now() - interval '30 days';
  return jsonb_build_object(
    'events', v_events,
    'cron_failed', v_cron,
    'uploads_bytes', (select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o where o.bucket_id = 'uploads'),
    'storage_bytes', (select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o),
    'db_bytes', pg_database_size(current_database()),
    'cleanup_overdue', (select count(*) from public.orders o join public.shops s on s.id = o.shop_id
        where o.files_deleted = false and o.status in ('ready', 'done', 'cancelled')
          and o.created_at < now() - make_interval(hours => public.shop_file_hours(s)) - interval '2 hours'),
    'stuck_uploading', (select count(*) from public.orders o
        where o.status = 'uploading' and o.files_deleted = false and o.created_at < now() - interval '2 hours')
  );
end $$;
revoke all on function public.ops_health(int) from public, anon, authenticated;
grant execute on function public.ops_health(int) to service_role;

notify pgrst, 'reload schema';
