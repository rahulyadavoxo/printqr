-- PrintQR v23 migration (2026-11-21): ID card sheet, "print again" (reorder), paper stock.
-- Safe to run more than once. Needs v4 (pg_net, private.cron_tokens), v14 (push), v17 (plan features), v18.
-- Then deploy the Edge Functions: reorder (new), finalize-order, push-new-order.
--
-- A. ID card print sheet (Pro / Plus, like the passport sheet): order_files.item_kind 'idcard'.
--    The customer's phone makes one A4 page (front above back at real card size, 85.6 x 54 mm);
--    price = copies x rates.idcard_sheet (20 when the shop has not set it). Free shops: rejected.
-- B. Print again: reorder() makes a NEW order (new token) from an old order's files, priced again on
--    the server. The files are not uploaded again: the Edge Function 'reorder' copies each stored object
--    to the new order's own path (order_files.source_path says where from), then reorder_finalize()
--    queues the order. Every order keeps its own objects, so one order's auto-delete never removes
--    another order's files.
-- C. Paper stock (all plans): shops.paper_sheets (null = not tracked), paper_low_at (default 200),
--    paper_alerted_at. When an order becomes 'done' its sheets are taken off once (orders.paper_used);
--    when the stock drops below paper_low_at the owner's phones get one push (again only after a top-up).

-- ============ A. ID card sheet ============

alter table public.order_files drop constraint if exists order_files_item_kind_check;
alter table public.order_files add constraint order_files_item_kind_check check (item_kind in ('print', 'passport', 'idcard'));

-- ID card item (Pro only): {"kind":"idcard","name":"id-card.pdf","mime":"application/pdf","size":1234,"copies":2,"color":true}
--   -> 1 page, printed `copies` times, price = copies x rates.idcard_sheet (default 20)
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
    if v_f->>'kind' = 'idcard' and v_mime <> 'application/pdf' then
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
grant execute on function public.create_order(text, text, text, jsonb, uuid) to anon, authenticated;

-- Upload page: Pro shops also get the ID card rate (20 when not set); free shops get neither sheet rate,
-- so even an old cached app hides both options. Same columns as v17.
create or replace function public.get_shop_public(p_slug text)
returns table (id uuid, name text, address text, is_open boolean, rates jsonb, upi_id text, is_pro boolean,
  is_plus boolean, logo_url text, brand_color text, max_order_mb int, file_hours int, hours jsonb)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.address, s.is_open,
    case when public.is_pro(s) then jsonb_build_object('passport_sheet', 40, 'idcard_sheet', 20) || s.rates
         else s.rates - 'passport_sheet' - 'idcard_sheet' end,
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

-- ============ B. Print again (reorder) ============

-- Set only on a reorder's files: the object (of the earlier order, same shop) the file is copied from.
alter table public.order_files add column if not exists source_path text;

-- Customers may upload only to their own new order's paths, never to a reorder's (those are copied on the server).
create or replace function public.can_upload(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.order_files f join public.orders o on o.id = f.order_id
    where f.storage_path = p_name and f.source_path is null
      and o.status = 'uploading' and o.created_at > now() - interval '30 minutes'
  );
$$;
grant execute on function public.can_upload(text) to anon, authenticated;

-- Status page: may this order be printed again, and with what files / rates.
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
    'can', not v_order.files_deleted and v_order.status in ('received', 'printing', 'ready', 'done')
           and v_shop.is_open and not v_shop.blocked,
    'is_open', v_shop.is_open and not v_shop.blocked,
    'rates', case when v_pro then jsonb_build_object('passport_sheet', 40, 'idcard_sheet', 20) || v_shop.rates
                  else v_shop.rates - 'passport_sheet' - 'idcard_sheet' end,
    'files', case when v_order.files_deleted then '[]'::jsonb else coalesce((
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

-- p_items: [{"file_id": "<order_files.id of the old order>", "copies": 1..100, "color": true|false}, ...]
-- Pages, sides, binding and lamination stay as they were; the price is worked out again with today's rates.
-- The new order waits in 'uploading' (hidden from the shop) until the Edge Function 'reorder' has copied
-- the files and called reorder_finalize(). If that never happens, the cleanup job cancels it after 1 hour.
create or replace function public.reorder(p_order_id uuid, p_key uuid, p_items jsonb)
returns table (order_id uuid, access_key uuid, token int, shop_id uuid, total numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_src public.orders;
  v_shop public.shops;
  v_pro boolean;
  v_order public.orders;
  v_token int;
  v_total numeric(10,2) := 0;
  v_item jsonb;
  v_f public.order_files;
  v_i int := 0;
  v_copies int;
  v_color boolean;
  v_binding boolean;
  v_lam boolean;
  v_price numeric(10,2);
  v_path text;
  v_bytes bigint := 0;
  v_max bigint;
  v_ip text;
  v_seen uuid[] := '{}';
  v_counter_id uuid;
  v_counter_name text;
  v_day_start timestamptz := (date_trunc('day', now() at time zone 'Asia/Kolkata')) at time zone 'Asia/Kolkata';
begin
  select * into v_src from public.orders o where o.id = p_order_id and o.access_key = p_key;
  if not found then raise exception 'Order not found'; end if;
  if v_src.files_deleted then raise exception 'The files of this order are already deleted. Please send them again.'; end if;
  if v_src.status not in ('received', 'printing', 'ready', 'done') then raise exception 'This order cannot be printed again'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'No files';
  end if;
  if jsonb_array_length(p_items) > 20 then raise exception 'Max 20 files per order'; end if;

  select * into v_shop from public.shops s where s.id = v_src.shop_id for update;
  if not found or v_shop.blocked then raise exception 'Shop not found'; end if;
  if not v_shop.is_open then raise exception 'Shop is closed right now'; end if;

  -- Same anti-spam as create_order.
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

  -- Check every item before anything is written: own files only, once each, copies 1-100, plan still allows it.
  v_pro := public.is_pro(v_shop);
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' or coalesce(v_item->>'file_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'File not found';
    end if;
    select * into v_f from public.order_files f where f.id = (v_item->>'file_id')::uuid and f.order_id = v_src.id;
    if not found or v_f.id = any (v_seen) then raise exception 'File not found'; end if;
    v_seen := v_seen || v_f.id;
    if coalesce(v_item->>'copies', '') !~ '^[0-9]{1,3}$' then raise exception 'Copies must be from 1 to 100'; end if;
    if (v_item->>'copies')::int not between 1 and 100 then raise exception 'Copies must be from 1 to 100'; end if;
    if v_item ? 'color' and jsonb_typeof(v_item->'color') <> 'boolean' then raise exception 'Bad print option'; end if;
    if v_f.item_kind = 'passport' and not v_pro then raise exception 'Passport photo sheet is not available at this shop'; end if;
    if v_f.item_kind = 'idcard' and not v_pro then raise exception 'ID card sheet is not available at this shop'; end if;
    v_bytes := v_bytes + coalesce(v_f.size_bytes, 0);
  end loop;
  v_max := public.plan_order_bytes(v_shop);
  if v_bytes > v_max then raise exception 'This shop accepts up to % MB per order', v_max / 1048576; end if;
  if v_ip is not null then insert into public.order_rate (ip_hash) values (v_ip); end if;

  -- Same counter as before (if it still exists and the plan still allows it), else the main queue.
  if v_src.counter_id is not null then
    select c.id, c.name into v_counter_id, v_counter_name
      from public.counters c where c.id = v_src.counter_id and c.shop_id = v_shop.id
        and (v_pro or c.id in (
          select c2.id from public.counters c2 where c2.shop_id = v_shop.id
          order by c2.created_at, c2.id limit public.free_counter_limit()));
  end if;

  select coalesce(max(o.token), 0) + 1 into v_token
    from public.orders o where o.shop_id = v_shop.id and o.created_at >= v_day_start;

  insert into public.orders (shop_id, token, customer_name, note, counter_id, counter_name, lang)
    values (v_shop.id, v_token, v_src.customer_name, v_src.note, v_counter_id, v_counter_name, v_src.lang)
    returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_i := v_i + 1;
    select * into v_f from public.order_files f where f.id = (v_item->>'file_id')::uuid and f.order_id = v_src.id;
    v_copies := (v_item->>'copies')::int;
    v_binding := false;
    v_lam := false;
    if v_f.item_kind = 'passport' then
      v_color := true;
      v_price := round(v_f.pages_to_print * v_copies * coalesce((v_shop.rates ->> 'passport_sheet')::numeric, 40), 2);
    elsif v_f.item_kind = 'idcard' then
      v_color := coalesce((v_item->>'color')::boolean, v_f.color);
      v_price := round(v_copies * coalesce((v_shop.rates ->> 'idcard_sheet')::numeric, 20), 2);
    else
      v_color := coalesce((v_item->>'color')::boolean, v_f.color);
      v_binding := v_f.binding and coalesce((v_shop.rates ->> 'binding')::numeric, 0) > 0;
      v_lam := v_f.lamination and coalesce((v_shop.rates ->> 'lamination')::numeric, 0) > 0;
      v_price := public.file_price(v_shop.rates, v_f.pages_to_print, v_copies, v_color, v_f.duplex, v_binding, v_lam);
    end if;
    v_total := v_total + v_price;
    v_path := v_shop.id::text || '/' || v_order.id::text || '/' || v_i::text || '-' ||
      left(regexp_replace(coalesce(v_f.file_name, 'file'), '[^A-Za-z0-9._-]', '_', 'g'), 80);
    insert into public.order_files (order_id, shop_id, storage_path, file_name, mime, size_bytes,
        total_pages, page_range, pages_to_print, copies, color, duplex, price, item_kind, photos, binding, lamination, source_path)
      values (v_order.id, v_shop.id, v_path, v_f.file_name, v_f.mime, v_f.size_bytes,
        v_f.total_pages, v_f.page_range, v_f.pages_to_print, v_copies, v_color, v_f.duplex, v_price,
        v_f.item_kind, v_f.photos, v_binding, v_lam, v_f.storage_path);
  end loop;

  update public.orders set total = v_total where id = v_order.id;

  return query select v_order.id, v_order.access_key, v_token, v_shop.id, v_total;
end $$;
revoke all on function public.reorder(uuid, uuid, jsonb) from public;
grant execute on function public.reorder(uuid, uuid, jsonb) to anon, authenticated;

-- Edge Function 'reorder' (service role), after copying: every copy must be there, then the order goes
-- to the shop ('received' -> new-order push, as for a normal order).
create or replace function public.reorder_finalize(p_order_id uuid, p_key uuid)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_missing int;
begin
  select * into v_order from public.orders o
    where o.id = p_order_id and o.access_key = p_key and o.status = 'uploading' for update;
  if not found then raise exception 'Order not found'; end if;
  -- Only reorders (every file has a source); normal orders go through finalize_order_counted.
  if not exists (select 1 from public.order_files f where f.order_id = v_order.id)
     or exists (select 1 from public.order_files f where f.order_id = v_order.id and f.source_path is null) then
    raise exception 'Order not found';
  end if;
  select count(*) into v_missing from public.order_files f
    where f.order_id = v_order.id and not exists (
      select 1 from storage.objects so
      where so.bucket_id = 'uploads' and so.name = f.storage_path
        and coalesce((so.metadata->>'size')::bigint, f.size_bytes) = f.size_bytes);
  if v_missing > 0 then raise exception 'Some files could not be copied. Please try again.'; end if;
  update public.orders set status = 'received', updated_at = now() where id = v_order.id;
  return v_order.total;
end $$;
revoke all on function public.reorder_finalize(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reorder_finalize(uuid, uuid) to service_role;

-- ============ C. Paper stock + low alert (all plans) ============

alter table public.shops add column if not exists paper_sheets int;            -- null = not tracked
alter table public.shops add column if not exists paper_low_at int not null default 200;
alter table public.shops add column if not exists paper_alerted_at timestamptz; -- set by the trigger only
alter table public.shops drop constraint if exists shops_paper_check;
alter table public.shops add constraint shops_paper_check check (
  (paper_sheets is null or paper_sheets between 0 and 10000000) and paper_low_at between 0 and 10000000);
grant update (paper_sheets, paper_low_at) on public.shops to authenticated;

-- Sheets an order used (set once, when it first becomes 'done'). Not owner-editable.
alter table public.orders add column if not exists paper_used int;

-- Below the limit -> remember the alert (and push when the drop came from printed orders);
-- back at or above the limit (top-up) or tracking off -> forget it, so the next drop alerts again.
-- Not security definer on purpose: current_user tells an owner's own edit ('authenticated', no push:
-- they just typed the number) from the orders trigger below (definer).
create or replace function public.shops_paper_alert()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.paper_sheets is null or new.paper_sheets >= new.paper_low_at then
    new.paper_alerted_at := null;
  elsif new.paper_alerted_at is null then
    new.paper_alerted_at := now();
    if current_user not in ('authenticated', 'anon') then
      begin
        perform net.http_post(
          url := 'https://asqgdgzxkdksoikmffmd.supabase.co/functions/v1/push-new-order',
          body := jsonb_build_object('kind', 'paper_low', 'shop_id', new.id),
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-cron-token', (select token from private.cron_tokens where name = 'push')
          ),
          timeout_milliseconds := 10000
        );
      exception when others then
        null;  -- a notification problem must never block the stock update
      end;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists shops_paper_alert on public.shops;
create trigger shops_paper_alert before update of paper_sheets, paper_low_at on public.shops
  for each row execute function public.shops_paper_alert();

-- Order marked done: take its sheets off the stock once (never below 0; nothing when not tracked).
-- Per file: both sides -> pages / 2 rounded up, else pages; x copies. Passport / ID card: sheets x copies.
create or replace function public.orders_paper_used()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_used int;
begin
  if new.status = 'done' and old.status is distinct from 'done' and new.paper_used is null then
    select coalesce(sum(
        (case when f.item_kind = 'print' and f.duplex then ceil(f.pages_to_print / 2.0)::int else f.pages_to_print end)
        * f.copies), 0)::int
      into v_used
      from public.order_files f where f.order_id = new.id;
    update public.shops set paper_sheets = greatest(0, paper_sheets - v_used)
      where id = new.shop_id and paper_sheets is not null and v_used > 0;
    new.paper_used := v_used;
  end if;
  return new;
exception when others then
  return new;  -- paper counting must never block an order's status
end $$;
drop trigger if exists orders_paper_used on public.orders;
create trigger orders_paper_used before update of status on public.orders
  for each row execute function public.orders_paper_used();

notify pgrst, 'reload schema';

-- Checks:
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'order_files_item_kind_check';
--   select id, name, paper_sheets, paper_low_at, paper_alerted_at from public.shops where paper_sheets is not null;
--   select id, status_code, content from net._http_response order by created desc limit 5;
