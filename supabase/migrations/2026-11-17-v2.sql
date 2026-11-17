-- PrintQR v2 migration (2026-11-17)
-- Adds: multiple counters, passport photo sheet rate + pricing, counter on orders.
-- Safe to run more than once. Paste the whole file in Supabase -> SQL Editor -> New query -> Run.

-- ============ RATES: passport photo sheet ============
alter table public.shops alter column rates
  set default '{"bw_single":2,"bw_double":1.5,"color_single":10,"color_double":8,"passport_sheet":40}'::jsonb;
update public.shops set rates = rates || jsonb_build_object('passport_sheet', 40)
  where not (rates ? 'passport_sheet');

-- ============ COUNTERS ============
create table if not exists public.counters (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now()
);
create index if not exists counters_shop on public.counters(shop_id, created_at);

alter table public.counters enable row level security;

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

grant select, insert, update, delete on public.counters to authenticated;
grant all on public.counters to service_role;

-- ============ ORDERS / ORDER FILES: new columns ============
alter table public.orders add column if not exists counter_id uuid references public.counters(id) on delete set null;
alter table public.orders add column if not exists counter_name text;
alter table public.order_files add column if not exists item_kind text not null default 'print';
alter table public.order_files add column if not exists photos int;
do $$ begin
  alter table public.order_files add constraint order_files_item_kind_check check (item_kind in ('print','passport'));
exception when duplicate_object then null; end $$;

-- Owners still may only change status / updated_at / files_deleted on orders.
revoke update on public.orders from authenticated, anon;
grant update (status, updated_at, files_deleted) on public.orders to authenticated;

-- ============ FUNCTIONS ============

-- Shop info for the customer upload page (rates always include passport_sheet, default 40)
create or replace function public.get_shop_public(p_slug text)
returns table (id uuid, name text, address text, is_open boolean, rates jsonb, upi_id text)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.address, s.is_open, jsonb_build_object('passport_sheet', 40) || s.rates, s.upi_id
  from public.shops s where s.slug = p_slug;
$$;
grant execute on function public.get_shop_public(text) to anon, authenticated;

-- Counter name for the customer page (QR link with ?c=<counter id>)
create or replace function public.get_counter_public(p_slug text, p_counter uuid)
returns text language sql stable security definer set search_path = public as $$
  select c.name from public.counters c join public.shops s on s.id = c.shop_id
  where s.slug = p_slug and c.id = p_counter;
$$;
grant execute on function public.get_counter_public(text, uuid) to anon, authenticated;

-- create_order gets an optional counter. The old 4-argument version is dropped so calls are not ambiguous.
drop function if exists public.create_order(text, text, text, jsonb);

-- Prices are calculated HERE from the shop's rates (never trusted from the browser).
-- p_files: [{"name":"a.pdf","mime":"application/pdf","size":1234,"total_pages":10,"page_range":"1-3","pages_to_print":3,"copies":1,"color":false,"duplex":false}]
-- Passport sheet item: {"kind":"passport","name":"passport.pdf","mime":"application/pdf","size":1234,"photos":16}
--   -> sheets = ceil(photos / 30) (30 photos of 35x45 mm fit on one A4), price = sheets * rates.passport_sheet
create or replace function public.create_order(p_slug text, p_customer_name text, p_note text, p_files jsonb, p_counter uuid default null)
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

  -- Unknown / deleted counter -> order goes to the default (no counter), so old QRs keep working.
  if p_counter is not null then
    select c.id, c.name into v_counter_id, v_counter_name
      from public.counters c where c.id = p_counter and c.shop_id = v_shop.id;
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

-- Make PostgREST pick up the new function / columns right away.
notify pgrst, 'reload schema';
