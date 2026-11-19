-- PrintQR v11 (2026-11-19): the server counts PDF pages, the customer's number is not trusted.
--
-- The Edge Function `finalize-order` downloads every uploaded PDF, counts its pages and calls
-- finalize_order_counted() below with the real counts. That fixes pages_to_print and the price of
-- each PDF, recomputes the order total, checks the files are complete and moves the order into the queue.
-- The customer can no longer call finalize_order directly (it skipped the page check).
--
-- Safe to run any time after the finalize-order function is deployed (it falls back to the old finalize until then).
-- Customers on an older app version see "update the app" from the in-app updater.

create or replace function public.finalize_order_counted(p_order_id uuid, p_key uuid, p_counts jsonb)
returns table (total numeric, changed int)
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_shop public.shops;
  v_f public.order_files;
  v_n int;
  v_rate numeric;
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
      v_rate := coalesce((v_shop.rates ->> (
        case when v_f.color then 'color' else 'bw' end || case when v_f.duplex then '_double' else '_single' end
      ))::numeric, 0);
      update public.order_files set pages_to_print = v_n, total_pages = v_n, page_range = null,
          price = round(v_n * v_f.copies * v_rate, 2)
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

-- The old entry point skipped the page check: only the server may use it now.
revoke execute on function public.finalize_order(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_order(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
