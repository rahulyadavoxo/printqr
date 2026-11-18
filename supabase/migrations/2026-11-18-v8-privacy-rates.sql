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
