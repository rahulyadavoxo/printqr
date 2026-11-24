-- PrintQR v44 migration (2026-11-25): security fixes. Safe to run more than once. Needs v25, v39, v42.
--
-- 1. Storage budgets (create_order): unfinished uploads ('uploading') count by the bytes really stored, not by
--    the sizes they declared, so orders that never upload hold no space. One network (request_ip_hash) may hold
--    at most app_settings.ip_pending_mb (default 250 MB) of declared-but-unfinished uploads in total, and at most
--    half of a shop's space (or one full order, if bigger) at one shop.
-- 2. reorder() ("Print again"): same Block sender, bot check (p_pass from upload-pass) and storage checks as
--    create_order; the network of a reprint is kept in order_senders too.
-- 3. redeem_coupon / coupon_check: a free-days Plus code on a running Pro plan is refused ('tier_higher_than_paid').
-- 4. report_client_error: at most 20 reports per 10 minutes per network, before the shared 300 cap.
-- 5. orders.files_deleted can be set by a shop owner / staff only when none of the order's files (or thumbnails)
--    is left in storage, so a half-done delete never hides files from auto-delete.

-- ============ settings + helpers ============
alter table public.app_settings add column if not exists ip_pending_mb int not null default 250;

create index if not exists order_senders_ip_idx on public.order_senders (ip_hash, created_at);

create or replace function public.ip_pending_cap_bytes()
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce((select ip_pending_mb from public.app_settings where id = 1), 250)::bigint * 1048576;
$$;
revoke all on function public.ip_pending_cap_bytes() from public, anon, authenticated;

-- Bytes of files not yet deleted (whole service when p_shop is null): sent orders by their checked size
-- (finalize-order compares it with the stored file), unfinished uploads by what is really in storage.
create or replace function public.live_file_bytes(p_shop uuid)
returns bigint language sql stable security definer set search_path = public, storage as $$
  select coalesce((select sum(f.size_bytes) from public.order_files f join public.orders o on o.id = f.order_id
      where o.files_deleted = false and o.status <> 'uploading' and (p_shop is null or o.shop_id = p_shop)), 0)::bigint
    + coalesce((select sum(coalesce((so.metadata->>'size')::bigint, 0))
      from public.orders o
      join public.order_files f on f.order_id = o.id
      join storage.objects so on so.bucket_id = 'uploads' and so.name in (f.storage_path, f.storage_path || '.thumb.jpg')
      where o.files_deleted = false and o.status = 'uploading' and (p_shop is null or o.shop_id = p_shop)), 0)::bigint;
$$;
revoke all on function public.live_file_bytes(uuid) from public, anon, authenticated;

-- Declared bytes of one network's unfinished uploads (last 35 minutes; older ones are cleaned up).
create or replace function public.ip_pending_bytes(p_ip text, p_shop uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(f.size_bytes), 0)::bigint
  from public.order_senders s
  join public.orders o on o.id = s.order_id
  join public.order_files f on f.order_id = o.id
  where s.ip_hash = p_ip and s.created_at > now() - interval '35 minutes'
    and o.status = 'uploading' and o.files_deleted = false
    and (p_shop is null or o.shop_id = p_shop);
$$;
revoke all on function public.ip_pending_bytes(text, uuid) from public, anon, authenticated;

-- ============ 1. create_order (from v25) ============
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

  -- v25 + v44: storage budgets (files not yet auto-deleted), so a flood of uploads cannot fill the storage for everyone.
  -- v44: unfinished uploads count by the bytes really stored (public.live_file_bytes), not by the sizes they
  -- declared, so orders that never upload hold no space; and one network may hold only a limited amount of
  -- declared-but-unfinished uploads (public.ip_pending_bytes), in total and at this shop.
  v_cap_shop := public.shop_storage_bytes(v_shop);
  v_cap_all := public.storage_budget_bytes();
  if v_ip is not null then
    if public.ip_pending_bytes(v_ip, null) + v_bytes > public.ip_pending_cap_bytes()
       or public.ip_pending_bytes(v_ip, v_shop.id) + v_bytes > greatest(v_max, v_cap_shop / 2) then
      raise exception 'Too many unfinished uploads from your network right now. Please wait a few minutes and try again.';
    end if;
  end if;
  v_live_shop := public.live_file_bytes(v_shop.id);
  if v_live_shop + v_bytes > v_cap_shop then
    raise exception 'This shop''s file space is full right now. Please ask the shop to finish or clear old orders, then try again.';
  end if;
  v_live_all := public.live_file_bytes(null);
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

-- ============ 2. reorder (from v23) with p_pass ============
-- The old 3-argument version is replaced (older pages call it with 3 named arguments: p_pass has a default).
drop function if exists public.reorder(uuid, uuid, jsonb);
create or replace function public.reorder(p_order_id uuid, p_key uuid, p_items jsonb, p_pass uuid default null)
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
  v_mode text;
  v_cap_shop bigint;
  v_cap_all bigint;
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

  -- v44: same "Block sender" and bot check as create_order.
  if v_ip is not null and exists (select 1 from public.shop_blocked_senders b where b.shop_id = v_shop.id and b.ip_hash = v_ip) then
    raise exception 'This shop is not accepting orders from your network.';
  end if;
  v_mode := coalesce((select order_captcha from public.app_settings where id = 1), 'auto');
  if v_mode = 'always' or (v_mode = 'auto' and (
       (v_ip is not null and (select count(*) from public.order_rate r where r.ip_hash = v_ip and r.created_at > now() - interval '10 minutes') >= 3)
       or (select count(*) from public.orders o where o.shop_id = v_shop.id and o.created_at > now() - interval '10 minutes') >= 20)) then
    if p_pass is null then raise exception 'captcha_required'; end if;
    delete from public.upload_pass up where up.created_at < now() - interval '1 hour';
    delete from public.upload_pass up where up.id = p_pass and up.created_at > now() - interval '10 minutes';
    if not found then raise exception 'captcha_required'; end if;
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

  -- v44: same storage budgets as create_order (the copies are new objects in this shop's folder).
  v_cap_shop := public.shop_storage_bytes(v_shop);
  v_cap_all := public.storage_budget_bytes();
  if v_ip is not null then
    if public.ip_pending_bytes(v_ip, null) + v_bytes > public.ip_pending_cap_bytes()
       or public.ip_pending_bytes(v_ip, v_shop.id) + v_bytes > greatest(v_max, v_cap_shop / 2) then
      raise exception 'Too many unfinished uploads from your network right now. Please wait a few minutes and try again.';
    end if;
  end if;
  if public.live_file_bytes(v_shop.id) + v_bytes > v_cap_shop then
    raise exception 'This shop''s file space is full right now. Please ask the shop to finish or clear old orders, then try again.';
  end if;
  if public.live_file_bytes(null) + v_bytes > v_cap_all then
    raise exception 'Uploads are paused for a short while because the service is very busy. Please try again later.';
  end if;
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
  -- v44: remember the network, so "Block sender" and the per-network upload limit also cover reprints.
  if v_ip is not null then
    insert into public.order_senders (order_id, shop_id, ip_hash) values (v_order.id, v_shop.id, v_ip);
  end if;

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
revoke all on function public.reorder(uuid, uuid, jsonb, uuid) from public;
grant execute on function public.reorder(uuid, uuid, jsonb, uuid) to anon, authenticated;

-- ============ 3. coupons (from v42) ============
create or replace function public.coupon_check(p_shop uuid, p_code text, p_log boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_c public.coupons;
  v_code text := upper(trim(coalesce(p_code, '')));
  v_pending int;
  v_err text;
  v_blocked boolean;
  v_found boolean;
begin
  select s.blocked into v_blocked from public.shops s where s.id = p_shop;
  if not found or coalesce(v_blocked, false) then return jsonb_build_object('ok', false, 'error', 'blocked'); end if;
  if not coalesce((select coupons_enabled from public.app_settings where id = 1), true) then
    return jsonb_build_object('ok', false, 'error', 'disabled');
  end if;
  if (select count(*) from public.coupon_tries where shop_id = p_shop and created_at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  select * into v_c from public.coupons where code = v_code;
  v_found := found;
  if v_found then
    select count(distinct k.shop_id) into v_pending from public.coupon_checkouts k
      where k.code = v_code and k.paid_at is null and k.shop_id <> p_shop and k.created_at > now() - interval '30 minutes';
  end if;
  if not v_found or not v_c.active then v_err := 'not_found';
  elsif v_c.expires_at is not null and v_c.expires_at <= now() then v_err := 'expired';
  elsif v_c.max_uses is not null and v_c.uses + coalesce(v_pending, 0) >= v_c.max_uses then v_err := 'used_up';
  elsif exists (select 1 from public.coupon_redemptions r where r.code = v_code and r.shop_id = p_shop) then v_err := 'already';
  -- v44: a free-days Plus code on a running Pro plan would turn all the paid Pro time into Plus.
  elsif v_c.kind <> 'percent' and v_c.tier = 'plus'
        and exists (select 1 from public.shops s where s.id = p_shop and public.is_pro(s) and not public.is_plus(s)) then
    v_err := 'tier_higher_than_paid';
  end if;
  if v_err is not null then
    if coalesce(p_log, true) then insert into public.coupon_tries (shop_id) values (p_shop); end if;
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;
  return jsonb_build_object('ok', true, 'kind', v_c.kind, 'code', v_c.code, 'percent', v_c.percent, 'mode', v_c.mode,
    'offer_id', v_c.offer_id, 'tiers', to_jsonb(v_c.tiers), 'periods', to_jsonb(v_c.periods), 'days', v_c.days, 'tier', v_c.tier,
    'expires_at', v_c.expires_at);
end $$;
revoke all on function public.coupon_check(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.coupon_check(uuid, text, boolean) to service_role;

create or replace function public.redeem_coupon(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_shop public.shops;
  v_c public.coupons;
  v_code text := upper(trim(coalesce(p_code, '')));
  v_tier text;
  v_end timestamptz;
  v_err text;
begin
  select * into v_shop from public.shops where owner_id = auth.uid() for update;
  if not found then raise exception 'not allowed'; end if;
  if v_shop.blocked then raise exception 'not allowed'; end if;
  if not coalesce((select coupons_enabled from public.app_settings where id = 1), true) then
    return jsonb_build_object('ok', false, 'error', 'disabled');
  end if;
  if (select count(*) from public.coupon_tries where shop_id = v_shop.id and created_at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  select * into v_c from public.coupons where code = v_code for update;
  -- % code: nothing is redeemed here; the Plan tab checks it through create-subscription and applies it at payment.
  if found and v_c.active and v_c.kind = 'percent' then
    return jsonb_build_object('ok', false, 'error', 'checkout', 'code', v_code);
  end if;
  if not found or not v_c.active then v_err := 'not_found';
  elsif v_c.expires_at is not null and v_c.expires_at <= now() then v_err := 'expired';
  elsif v_c.max_uses is not null and v_c.uses >= v_c.max_uses then v_err := 'used_up';
  elsif exists (select 1 from public.coupon_redemptions r where r.code = v_code and r.shop_id = v_shop.id) then v_err := 'already';
  -- v44: a free-days code for a higher plan than the running Pro plan is refused (it would upgrade all the paid
  -- Pro time to Plus). It can be used once the current plan has ended. Counts as a try (no free code check).
  elsif v_c.tier = 'plus' and public.is_pro(v_shop) and not public.is_plus(v_shop) then v_err := 'tier_higher_than_paid';
  end if;
  if v_err is not null then
    insert into public.coupon_tries (shop_id) values (v_shop.id);
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;
  v_tier := case when public.is_plus(v_shop) or v_c.tier = 'plus' then 'plus' else 'pro' end;
  v_end := greatest(coalesce(v_shop.plan_expires_at, now()), now()) + make_interval(days => v_c.days);
  update public.shops set plan = v_tier, plan_expires_at = v_end where id = v_shop.id;
  update public.coupons set uses = uses + 1 where code = v_code;
  insert into public.coupon_redemptions (code, shop_id, user_id, days, until) values (v_code, v_shop.id, auth.uid(), v_c.days, v_end);
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (null, 'coupon_redeemed', v_shop.id, jsonb_build_object('code', v_code, 'days', v_c.days, 'until', v_end,
            'before', v_shop.plan_expires_at, 'plan', v_tier, 'plan_before', v_shop.plan));
  return jsonb_build_object('ok', true, 'until', v_end, 'days', v_c.days, 'plan', v_tier);
end $$;
revoke all on function public.redeem_coupon(text) from public, anon;
grant execute on function public.redeem_coupon(text) to authenticated;

-- ============ 4. report_client_error (from v39) ============
create table if not exists public.client_error_rate (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists client_error_rate_ip_idx on public.client_error_rate (ip_hash, created_at);
create index if not exists client_error_rate_created_idx on public.client_error_rate (created_at);
alter table public.client_error_rate enable row level security;
revoke all on public.client_error_rate from anon, authenticated;

create or replace function public.report_client_error(p_source text, p_message text, p_where text default null,
  p_route text default null, p_version text default null, p_ua text default null, p_stack text default null)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  v_src text := case when p_source in ('web', 'app', 'desktop') then 'client-' || p_source else 'client-web' end;
  v_msg text;
  v_stack text;
  v_ip text;
begin
  v_msg := left(regexp_replace(regexp_replace(
             coalesce(nullif(trim(p_message), ''), 'unknown error') || coalesce(' @ ' || left(nullif(trim(p_where), ''), 80), ''),
             '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '<email>', 'g'),
             'eyJ[A-Za-z0-9._-]{20,}', '<token>', 'g'), 300);
  v_stack := left(regexp_replace(regexp_replace(nullif(trim(p_stack), ''),
             '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '<email>', 'g'),
             'eyJ[A-Za-z0-9._-]{20,}', '<token>', 'g'), 2000);
  -- v44: at most 20 reports per 10 minutes from one network (counted before the shared cap, so one network
  -- cannot use up the 300 for everyone)
  v_ip := public.request_ip_hash();
  if v_ip is not null then
    delete from public.client_error_rate where created_at < now() - interval '1 hour';
    if (select count(*) from public.client_error_rate r where r.ip_hash = v_ip and r.created_at > now() - interval '10 minutes') >= 20 then
      return;
    end if;
    insert into public.client_error_rate (ip_hash) values (v_ip);
  end if;
  -- at most 300 client reports per 10 minutes in total, and the same message once per 5 minutes
  if (select count(*) from public.ops_events where source like 'client-%' and created_at > now() - interval '10 minutes') >= 300 then return; end if;
  if exists (select 1 from public.ops_events where source = v_src and message = v_msg and created_at > now() - interval '5 minutes') then return; end if;
  insert into public.ops_events (source, level, message, route, app_version, ua, stack)
  values (v_src, 'client', v_msg,
          left(regexp_replace(nullif(trim(p_route), ''), '[?#].*$', ''), 120),
          left(nullif(trim(p_version), ''), 40), left(nullif(trim(p_ua), ''), 300), v_stack);
end $$;
revoke all on function public.report_client_error(text, text, text, text, text, text, text) from public;
grant execute on function public.report_client_error(text, text, text, text, text, text, text) to anon, authenticated;

-- ============ 5. files_deleted only when the files are gone ============
-- Runs before orders_purge_personal (triggers fire in name order), which renames the paths.
create or replace function public.orders_files_gone_guard()
returns trigger language plpgsql security definer set search_path = public, storage as $$
begin
  if new.files_deleted and not coalesce(old.files_deleted, false)
     and coalesce(auth.role(), '') = 'authenticated'
     and exists (select 1 from public.order_files f
                 join storage.objects so on so.bucket_id = 'uploads' and so.name in (f.storage_path, f.storage_path || '.thumb.jpg')
                 where f.order_id = new.id) then
    raise exception 'Some files of this order could not be deleted. Please try again.';
  end if;
  return new;
end $$;
drop trigger if exists orders_files_gone_guard on public.orders;
create trigger orders_files_gone_guard before update of files_deleted on public.orders
  for each row execute function public.orders_files_gone_guard();

notify pgrst, 'reload schema';
