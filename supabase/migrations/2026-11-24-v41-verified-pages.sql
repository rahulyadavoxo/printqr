-- PrintQR v41 (2026-11-24): the shop's total comes from page counts the server checked, never from the customer's numbers.
--
-- Before: create_order priced each file from the pages the customer's app reported. finalize-order (v11) recounted
-- normal PDFs, but a PDF it could not read failed the order, photos / Office files / passport sheets kept the
-- customer's number, and nothing told the shop what was checked.
--
--   1. order_files gets a per-file check result:
--        pages_status  'verified'   the server counted the pages and the customer's number was right
--                      'corrected'  the server counted more (or fewer) pages and re-priced the file with the shop's rates
--                      'unverified' the pages could not be counted (Office file, encrypted / broken / very large PDF,
--                                   or finalize never ran). Every new row starts 'unverified'.
--        pages_note    why a file is unverified (office, encrypted, too_big, too_complex, unreadable, timeout, not_checked)
--        pages_real    pages the server counted (null when unverified)
--        claimed_pages / claimed_total_pages / claimed_price   what the customer's app said (kept for audit)
--      A trigger fills the claimed_* columns on insert, so create_order / reorder need no change.
--   2. finalize_order_verified() (service role, called by the finalize-order Edge Function): takes the server's
--      results per file, fixes pages / page range / price with file_price() and the shop's rates, sets pages_status,
--      recomputes the order total from the stored prices and queues the order.
--   3. finalize_order_counted() (v11 entry point, still used by an older deployed finalize-order) now goes through
--      finalize_order_verified(), so it records statuses too.
--   4. reorder_finalize() copies the check result of the original file (the bytes are the same).
-- Old orders keep pages_status null (no badge). Safe to run more than once. Needs v25 (finalize_begin) and v23.

-- ============ 1. per-file check result ============
alter table public.order_files add column if not exists pages_status text;
alter table public.order_files add column if not exists pages_note text;
alter table public.order_files add column if not exists pages_real int;
alter table public.order_files add column if not exists claimed_pages int;
alter table public.order_files add column if not exists claimed_total_pages int;
alter table public.order_files add column if not exists claimed_price numeric(10,2);
-- Default only for new rows: existing rows stay null (no badge on old orders).
alter table public.order_files alter column pages_status set default 'unverified';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'order_files_pages_status_v41_check') then
    alter table public.order_files add constraint order_files_pages_status_v41_check
      check (pages_status is null or pages_status in ('verified', 'corrected', 'unverified'));
  end if;
end $$;

-- The customer's numbers as sent, kept apart from the (possibly corrected) live values.
create or replace function public.order_files_claimed_v41()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.claimed_pages is null then new.claimed_pages := new.pages_to_print; end if;
  if new.claimed_total_pages is null then new.claimed_total_pages := new.total_pages; end if;
  if new.claimed_price is null then new.claimed_price := new.price; end if;
  if new.pages_status is null then new.pages_status := 'unverified'; end if;
  return new;
end $$;
revoke all on function public.order_files_claimed_v41() from public, anon, authenticated;
drop trigger if exists order_files_claimed_v41 on public.order_files;
create trigger order_files_claimed_v41 before insert on public.order_files
  for each row execute function public.order_files_claimed_v41();

-- ============ 2. page range helper ============
-- Pages in a range like '1-5, 8, 10-12' when every page is inside 1..p_total; null when the range is empty,
-- malformed or goes past the real page count.
create or replace function public.page_range_count(p_range text, p_total int)
returns int language plpgsql immutable set search_path = public as $$
declare
  v_part text;
  v_a int;
  v_b int;
  v_seen int[] := '{}';
  v_m text[];
begin
  if p_range is null or btrim(p_range) = '' or p_total is null or p_total < 1 then return null; end if;
  if length(p_range) > 60 then return null; end if;
  foreach v_part in array string_to_array(regexp_replace(p_range, '\s', '', 'g'), ',') loop
    if v_part = '' then continue; end if;
    v_m := regexp_match(v_part, '^([0-9]{1,4})(?:-([0-9]{1,4}))?$');
    if v_m is null then return null; end if;
    v_a := v_m[1]::int;
    v_b := coalesce(v_m[2]::int, v_a);
    if v_a < 1 or v_b < v_a or v_b > p_total then return null; end if;
    select array_agg(distinct x) into v_seen from unnest(v_seen || array(select generate_series(v_a, v_b))) x;
  end loop;
  if coalesce(array_length(v_seen, 1), 0) = 0 then return null; end if;
  return array_length(v_seen, 1);
end $$;
grant execute on function public.page_range_count(text, int) to service_role;

-- ============ 3. finalize with server-checked pages ============
-- p_result: { "<order_files.id>": { "pages": 50 } }  counted by the server
--           { "<order_files.id>": { "why": "encrypted" } }  could not be counted
-- Files missing from p_result are 'unverified' with note 'not_checked'. Photos are always 1 page.
create or replace function public.finalize_order_verified(p_order_id uuid, p_key uuid, p_result jsonb)
returns table (total numeric, changed int, unverified int)
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_shop public.shops;
  v_f public.order_files;
  v_r jsonb;
  v_n int;
  v_why text;
  v_pages int;
  v_range text;
  v_range_n int;
  v_price numeric(10,2);
  v_status text;
  v_changed int := 0;
  v_unverified int := 0;
  v_missing int;
  v_total numeric(10,2);
begin
  select * into v_order from public.orders o
    where o.id = p_order_id and o.access_key = p_key and o.status = 'uploading' for update;
  if not found then raise exception 'Order not found'; end if;
  select * into v_shop from public.shops s where s.id = v_order.shop_id;
  if p_result is null or jsonb_typeof(p_result) <> 'object' then p_result := '{}'::jsonb; end if;

  for v_f in select * from public.order_files f where f.order_id = v_order.id order by f.storage_path loop
    v_r := p_result -> v_f.id::text;
    v_n := null;
    v_why := null;
    if jsonb_typeof(v_r) = 'object' and jsonb_typeof(v_r -> 'pages') = 'number' then
      v_n := (v_r ->> 'pages')::numeric::int;
      if v_n < 1 then v_n := null; v_why := 'unreadable'; end if;
    elsif jsonb_typeof(v_r) = 'object' then
      v_why := left(coalesce(v_r ->> 'why', 'unreadable'), 30);
    else
      v_why := 'not_checked';
    end if;
    if v_n is not null and v_n > 2000 then raise exception 'A PDF can have up to 2000 pages'; end if;

    -- Photos print as one page each, whatever the app said.
    if v_f.item_kind = 'print' and coalesce(v_f.mime, '') like 'image/%' then
      v_n := 1;
      v_why := null;
    elsif v_f.mime is distinct from 'application/pdf' then
      -- Word / Excel / PowerPoint: no converter on the server, the customer's number stays.
      v_n := null;
      v_why := 'office';
    end if;

    if v_n is null then
      v_unverified := v_unverified + 1;
      update public.order_files set pages_status = 'unverified', pages_note = coalesce(v_why, 'unreadable'), pages_real = null
        where id = v_f.id;
      continue;
    end if;

    if v_f.item_kind = 'passport' then
      -- Priced per sheet: a sheet PDF with more pages than its photos need is charged for every page.
      v_pages := greatest(v_f.pages_to_print, v_n);
      if v_pages <> v_f.pages_to_print then
        v_price := round(v_pages * coalesce((v_shop.rates ->> 'passport_sheet')::numeric, 40), 2);
        update public.order_files set pages_to_print = v_pages, total_pages = v_pages, price = v_price,
            pages_status = 'corrected', pages_note = null, pages_real = v_n
          where id = v_f.id;
        v_changed := v_changed + 1;
      else
        update public.order_files set pages_status = 'verified', pages_note = null, pages_real = v_n where id = v_f.id;
      end if;
      continue;
    end if;

    if v_f.item_kind = 'idcard' then
      -- finalize-order refuses an ID card sheet that is not exactly one page; priced per copy.
      if v_n <> 1 then raise exception 'The ID card sheet must be one page. Please make it again.'; end if;
      update public.order_files set pages_status = 'verified', pages_note = null, pages_real = 1 where id = v_f.id;
      continue;
    end if;

    -- Normal print file (PDF or photo). A page range is kept only when it fits inside the real pages;
    -- otherwise the whole file is what gets printed and charged.
    v_range := nullif(btrim(coalesce(v_f.page_range, '')), '');
    v_range_n := public.page_range_count(v_range, v_n);
    if v_range is not null and v_range_n is not null then
      v_pages := v_range_n;
    else
      v_range := null;
      v_pages := v_n;
    end if;
    v_price := public.file_price(v_shop.rates, v_pages, v_f.copies, v_f.color, v_f.duplex, v_f.binding, v_f.lamination);
    v_status := case when v_pages = v_f.pages_to_print and v_price = v_f.price
                       and v_range is not distinct from nullif(btrim(coalesce(v_f.page_range, '')), '')
                     then 'verified' else 'corrected' end;
    update public.order_files set pages_to_print = v_pages, total_pages = v_n, page_range = v_range, price = v_price,
        pages_status = v_status, pages_note = null, pages_real = v_n
      where id = v_f.id;
    if v_status = 'corrected' then v_changed := v_changed + 1; end if;
  end loop;

  select count(*) into v_missing from public.order_files f
    where f.order_id = v_order.id and not exists (
      select 1 from storage.objects so
      where so.bucket_id = 'uploads' and so.name = f.storage_path
        and (so.metadata->>'size')::bigint = f.size_bytes);
  if v_missing > 0 then raise exception 'Some files did not upload completely. Please try again.'; end if;

  -- The shop's total is always the sum of the stored (server-priced) file prices.
  select coalesce(sum(f.price), 0) into v_total from public.order_files f where f.order_id = v_order.id;
  update public.orders set total = v_total, status = 'received', updated_at = now() where id = v_order.id;
  return query select v_total::numeric, v_changed, v_unverified;
end $$;
revoke all on function public.finalize_order_verified(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_order_verified(uuid, uuid, jsonb) to service_role;

-- v11 entry point: { "<file id>": 50 } counts for print PDFs only. Same checks, same statuses.
create or replace function public.finalize_order_counted(p_order_id uuid, p_key uuid, p_counts jsonb)
returns table (total numeric, changed int)
language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb := '{}'::jsonb;
  v_k text;
  v_v jsonb;
begin
  if p_counts is not null and jsonb_typeof(p_counts) = 'object' then
    for v_k, v_v in select * from jsonb_each(p_counts) loop
      if jsonb_typeof(v_v) = 'number' then v_result := v_result || jsonb_build_object(v_k, jsonb_build_object('pages', v_v)); end if;
    end loop;
  end if;
  return query select r.total, r.changed from public.finalize_order_verified(p_order_id, p_key, v_result) r;
end $$;
revoke all on function public.finalize_order_counted(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_order_counted(uuid, uuid, jsonb) to service_role;

-- ============ 4. reorder: same bytes, same check result ============
create or replace function public.reorder_finalize(p_order_id uuid, p_key uuid)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_missing int;
begin
  select * into v_order from public.orders o
    where o.id = p_order_id and o.access_key = p_key and o.status = 'uploading' for update;
  if not found then raise exception 'Order not found'; end if;
  -- Only reorders (every file has a source); normal orders go through finalize_order_verified.
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
  -- Pages were checked (and if needed corrected) on the original order and reorder() priced from those, so a
  -- checked source is 'verified' here. Orders from before v41: PDFs were counted by v11, single photos are one page.
  update public.order_files nf set
      pages_status = case
        when sf.pages_status in ('verified', 'corrected') then 'verified'
        when sf.pages_status = 'unverified' then 'unverified'
        when sf.mime = 'application/pdf' or (coalesce(sf.mime, '') like 'image/%' and sf.pages_to_print = 1) then 'verified'
        else 'unverified' end,
      pages_note = case when sf.pages_status = 'unverified' then sf.pages_note
                        when sf.pages_status is null and sf.mime is distinct from 'application/pdf'
                             and not (coalesce(sf.mime, '') like 'image/%' and sf.pages_to_print = 1) then 'not_checked'
                        else null end,
      pages_real = sf.pages_real
    from public.order_files sf
    where nf.order_id = v_order.id and sf.storage_path = nf.source_path;
  update public.orders set status = 'received', updated_at = now() where id = v_order.id;
  return v_order.total;
end $$;
revoke all on function public.reorder_finalize(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reorder_finalize(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
