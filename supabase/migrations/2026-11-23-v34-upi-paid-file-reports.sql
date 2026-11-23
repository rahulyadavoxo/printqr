-- PrintQR v34 migration (2026-11-23): UPI "Paid" mark (item 16) + "Report file" and takedown hold (item 17).
-- Safe to run more than once. Needs v25.
--
-- 1. orders.paid_at / paid_by: the shop marks an order Paid / Unpaid with set_order_paid() (owner or staff).
--    get_order_status() also returns paid, so the customer's page shows "Paid ✓".
-- 2. orders.hold: a reported order. Its files are kept (cleanup skips it), the shop cannot open or delete
--    them any more, and it cannot be printed again. Only an admin ends the hold (admin-action:
--    report_dismiss / report_delete_files). See docs/takedown-sop.md.
-- 3. file_reports: one row per report (owner / staff of the shop insert and read their own, admins read all).
--    report_order_files() is what the dashboard calls.

-- ============ columns ============
alter table public.orders add column if not exists paid_at timestamptz;
alter table public.orders add column if not exists paid_by uuid references auth.users (id) on delete set null;
alter table public.orders add column if not exists hold boolean not null default false;
create index if not exists orders_hold_idx on public.orders (id) where hold;

-- ============ 1. Paid / Unpaid ============
-- Owners / staff may only update status, updated_at and files_deleted on orders, so this runs as definer.
create or replace function public.set_order_paid(p_order_id uuid, p_paid boolean)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  v_shop uuid;
  v_at timestamptz;
begin
  select o.shop_id into v_shop from public.orders o where o.id = p_order_id;
  if v_shop is null or not public.can_manage_shop(v_shop) then raise exception 'not allowed'; end if;
  update public.orders o
    set paid_at = case when coalesce(p_paid, false) then coalesce(o.paid_at, now()) end,
        paid_by = case when coalesce(p_paid, false) then coalesce(o.paid_by, auth.uid()) end
    where o.id = p_order_id
    returning o.paid_at into v_at;
  return v_at;
end $$;
revoke all on function public.set_order_paid(uuid, boolean) from public, anon;
grant execute on function public.set_order_paid(uuid, boolean) to authenticated;

-- Customer status page: same as v17 plus paid (the return type changes, so drop and create).
drop function if exists public.get_order_status(uuid, uuid);
create function public.get_order_status(p_order_id uuid, p_key uuid)
returns table (token int, status text, total numeric, created_at timestamptz, shop_name text, upi_id text, file_count int,
  files_deleted boolean, files_expire_at timestamptz, is_plus boolean, logo_url text, brand_color text, paid boolean)
language sql stable security definer set search_path = public as $$
  select o.token, o.status, o.total, o.created_at, s.name, s.upi_id,
    (select count(*)::int from public.order_files f where f.order_id = o.id),
    o.files_deleted,
    o.created_at + make_interval(hours => public.shop_file_hours(s)),
    public.is_plus(s),
    case when public.is_plus(s) then s.logo_url end,
    case when public.is_plus(s) then s.brand_color end,
    o.paid_at is not null
  from public.orders o join public.shops s on s.id = o.shop_id
  where o.id = p_order_id and o.access_key = p_key;
$$;
grant execute on function public.get_order_status(uuid, uuid) to anon, authenticated;

-- ============ 2. hold: keep reported files ============
-- Cleanup: same as v25, but held (reported) orders keep their files until an admin decides.
create or replace function public.cleanup_candidates()
returns table (order_id uuid, status text, paths text[])
language sql stable security definer set search_path = public as $$
  select o.id, o.status, array(select f.storage_path from public.order_files f where f.order_id = o.id)
  from public.orders o join public.shops s on s.id = o.shop_id
  where o.files_deleted = false and not o.hold and (
    (o.status = 'uploading' and o.created_at < now() - interval '35 minutes')
    or (o.status in ('ready', 'done', 'cancelled') and o.created_at < now() - make_interval(hours => public.shop_file_hours(s)))
    or (o.status in ('received', 'printing')
        and o.created_at < now() - make_interval(hours => greatest(public.shop_file_hours(s), 48)))
  )
  limit 500;
$$;
revoke all on function public.cleanup_candidates() from public, anon, authenticated;
grant execute on function public.cleanup_candidates() to service_role;

-- Is this storage object ('<shop>/<order>/<file>') part of a held order?
create or replace function public.upload_held(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select case when split_part(coalesce(p_name, ''), '/', 2) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then exists (select 1 from public.orders o where o.id = split_part(p_name, '/', 2)::uuid and o.hold)
    else false end;
$$;
revoke all on function public.upload_held(text) from public;
grant execute on function public.upload_held(text) to authenticated;

-- Shop owner / staff can no longer open or delete the files of a held order (admins use the service role).
drop policy if exists "owner reads uploads" on storage.objects;
create policy "owner reads uploads" on storage.objects for select to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] in (select id::text from public.shops where owner_id = auth.uid())
    and not public.upload_held(name));
drop policy if exists "owner deletes uploads" on storage.objects;
create policy "owner deletes uploads" on storage.objects for delete to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] in (select id::text from public.shops where owner_id = auth.uid())
    and not public.upload_held(name));
drop policy if exists "staff reads uploads" on storage.objects;
create policy "staff reads uploads" on storage.objects for select to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] in (select x::text from public.staff_shop_ids() x)
    and not public.upload_held(name));
drop policy if exists "staff deletes uploads" on storage.objects;
create policy "staff deletes uploads" on storage.objects for delete to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] in (select x::text from public.staff_shop_ids() x)
    and not public.upload_held(name));

-- A signed-in shop login cannot mark a held order's files as deleted (the service role and admins can).
create or replace function public.orders_hold_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.hold and new.files_deleted and not old.files_deleted and auth.uid() is not null and not public.is_admin() then
    raise exception 'This order is under review. Its files are kept.';
  end if;
  return new;
end $$;
drop trigger if exists orders_hold_guard on public.orders;
create trigger orders_hold_guard before update of files_deleted on public.orders
  for each row execute function public.orders_hold_guard();

-- "Print again" (v23): not for a held order.
create or replace function public.reorder_info(p_order_id uuid, p_key uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_order public.orders;
  v_shop public.shops;
  v_pro boolean;
begin
  select * into v_order from public.orders o where o.id = p_order_id and o.access_key = p_key;
  if not found then raise exception 'Order not found'; end if;
  select * into v_shop from public.shops s where s.id = v_order.shop_id;
  v_pro := public.is_pro(v_shop);
  return jsonb_build_object(
    'can', not v_order.files_deleted and not v_order.hold and v_order.status in ('received', 'printing', 'ready', 'done')
           and v_shop.is_open and not v_shop.blocked,
    'is_open', v_shop.is_open and not v_shop.blocked,
    'rates', case when v_pro then jsonb_build_object('passport_sheet', 40, 'idcard_sheet', 20) || v_shop.rates
                  else v_shop.rates - 'passport_sheet' - 'idcard_sheet' end,
    'files', case when v_order.files_deleted or v_order.hold then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', f.id, 'file_name', f.file_name, 'item_kind', f.item_kind, 'pages', f.pages_to_print,
          'copies', f.copies, 'color', f.color, 'duplex', f.duplex, 'binding', f.binding,
          'lamination', f.lamination, 'photos', f.photos,
          'allowed', f.item_kind = 'print' or v_pro)
        order by coalesce(substring(f.storage_path from '/([0-9]+)-[^/]*$')::int, 0), f.id)
      from public.order_files f where f.order_id = v_order.id), '[]'::jsonb) end
  );
end $$;
revoke all on function public.reorder_info(uuid, uuid) from public;
grant execute on function public.reorder_info(uuid, uuid) to anon, authenticated;

-- reorder() copies files by order_files.source_path: refuse a copy of a held order's file.
create or replace function public.order_files_hold_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.source_path is not null and exists (
      select 1 from public.order_files f join public.orders o on o.id = f.order_id
      where f.storage_path = new.source_path and o.hold) then
    raise exception 'This order cannot be printed again';
  end if;
  return new;
end $$;
drop trigger if exists order_files_hold_guard on public.order_files;
create trigger order_files_hold_guard before insert on public.order_files
  for each row execute function public.order_files_hold_guard();

-- ============ 3. file reports ============
create table if not exists public.file_reports (
  id bigint generated always as identity primary key,
  -- Kept when the order or shop row is removed later (the report is the record).
  order_id uuid references public.orders (id) on delete set null,
  shop_id uuid references public.shops (id) on delete set null,
  reporter_id uuid references auth.users (id) on delete set null,
  reason text not null check (reason in ('csam', 'illegal', 'violence', 'copyright', 'privacy', 'other')),
  note text check (note is null or char_length(note) <= 500),
  -- Filled from the order when the report is made (for the admin list and the record).
  token int,
  shop_name text,
  file_names text[] not null default '{}',
  paths text[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'dismissed', 'files_deleted')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null
);
create index if not exists file_reports_status_idx on public.file_reports (status, created_at desc);
create index if not exists file_reports_order_idx on public.file_reports (order_id);
create index if not exists file_reports_shop_idx on public.file_reports (shop_id, created_at desc);
alter table public.file_reports enable row level security;
revoke all on public.file_reports from public, anon, authenticated;
grant select on public.file_reports to authenticated;
grant insert (order_id, reason, note) on public.file_reports to authenticated;
grant select, insert, update on public.file_reports to service_role;

drop policy if exists "shop inserts file reports" on public.file_reports;
create policy "shop inserts file reports" on public.file_reports for insert to authenticated
  with check (shop_id is not null and public.can_manage_shop(shop_id) and reporter_id = auth.uid());
drop policy if exists "shop reads own file reports" on public.file_reports;
create policy "shop reads own file reports" on public.file_reports for select to authenticated
  using (reporter_id = auth.uid() or (shop_id is not null and public.can_manage_shop(shop_id)));
drop policy if exists "admin reads file reports" on public.file_reports;
create policy "admin reads file reports" on public.file_reports for select to authenticated
  using (public.is_admin());

-- Every new report (also a direct insert): check the caller, fill the order details, put the order on hold.
create or replace function public.file_reports_fill()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  select * into v_order from public.orders o where o.id = new.order_id;
  if not found or not public.can_manage_shop(v_order.shop_id) then raise exception 'not allowed'; end if;
  if new.reason is null or new.reason not in ('csam', 'illegal', 'violence', 'copyright', 'privacy', 'other') then
    raise exception 'Please choose a reason';
  end if;
  if v_order.files_deleted then raise exception 'These files are already deleted, so they cannot be reported'; end if;
  if (select count(*) from public.file_reports r where r.shop_id = v_order.shop_id and r.created_at > now() - interval '1 day') >= 20 then
    raise exception 'Too many reports. Please try again tomorrow.';
  end if;
  new.shop_id := v_order.shop_id;
  new.reporter_id := auth.uid();
  new.note := left(nullif(trim(coalesce(new.note, '')), ''), 500);
  new.token := v_order.token;
  new.shop_name := (select s.name from public.shops s where s.id = v_order.shop_id);
  new.file_names := array(select f.file_name from public.order_files f where f.order_id = v_order.id order by f.storage_path);
  new.paths := array(select f.storage_path from public.order_files f where f.order_id = v_order.id order by f.storage_path);
  new.status := 'open';
  new.created_at := now();
  new.resolved_at := null;
  new.resolved_by := null;
  update public.orders o set hold = true where o.id = v_order.id;
  return new;
end $$;
drop trigger if exists file_reports_fill on public.file_reports;
create trigger file_reports_fill before insert on public.file_reports
  for each row execute function public.file_reports_fill();

-- Dashboard "Report file": holds the order and records the report. Returns the report id.
create or replace function public.report_order_files(p_order_id uuid, p_reason text, p_note text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_shop uuid;
  v_id bigint;
begin
  select o.shop_id into v_shop from public.orders o where o.id = p_order_id;
  if v_shop is null or not public.can_manage_shop(v_shop) then raise exception 'not allowed'; end if;
  insert into public.file_reports (order_id, reason, note) values (p_order_id, p_reason, p_note) returning id into v_id;
  update public.orders o set hold = true where o.id = p_order_id;
  return v_id;
end $$;
revoke all on function public.report_order_files(uuid, text, text) from public, anon;
grant execute on function public.report_order_files(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
