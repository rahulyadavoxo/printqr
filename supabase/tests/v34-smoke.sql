-- Smoke test for v34 (UPI paid mark + file reports / hold). Runs in CI on a throw-away local Supabase.
-- Everything happens in one transaction that is rolled back at the end.
\set ON_ERROR_STOP 1
begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000034a1', 'owner34-test@example.com'),
  ('00000000-0000-0000-0000-0000000034a2', 'other34-test@example.com');
insert into public.shops (id, owner_id, name, slug, upi_id) values
  ('00000000-0000-0000-0000-0000000034b1', '00000000-0000-0000-0000-0000000034a1', 'Test Shop 34', 'test-shop-v34', 'shop34@upi'),
  ('00000000-0000-0000-0000-0000000034b2', '00000000-0000-0000-0000-0000000034a2', 'Other Shop 34', 'other-shop-v34', null);

select set_config('request.headers', '{"x-real-ip": "203.0.113.34"}', true);
set local role anon;
do $$ declare r record; begin
  select * into r from public.create_order('test-shop-v34', 'A', null,
    '[{"name":"a.pdf","mime":"application/pdf","size":1000,"pages_to_print":2,"total_pages":2}]'::jsonb);
  perform set_config('pq.o34', r.order_id::text, true);
  perform set_config('pq.k34', r.access_key::text, true);
end $$;
reset role;
update public.orders set status = 'received' where id = current_setting('pq.o34')::uuid;

-- 1. Paid mark: the owner can, another shop's owner cannot; the customer page shows it
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000034a2", "role": "authenticated"}', true);
set local role authenticated;
do $$ begin
  perform public.set_order_paid(current_setting('pq.o34')::uuid, true);
  raise exception 'TEST FAILED: another shop could mark the order paid';
exception when others then
  if sqlerrm <> 'not allowed' then raise; end if;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000034a1", "role": "authenticated"}', true);
set local role authenticated;
do $$ declare v timestamptz; p boolean; begin
  v := public.set_order_paid(current_setting('pq.o34')::uuid, true);
  if v is null then raise exception 'TEST FAILED: paid_at not set'; end if;
  select s.paid into p from public.get_order_status(current_setting('pq.o34')::uuid, current_setting('pq.k34')::uuid) s;
  if p is not true then raise exception 'TEST FAILED: get_order_status paid is not true'; end if;
  v := public.set_order_paid(current_setting('pq.o34')::uuid, false);
  if v is not null then raise exception 'TEST FAILED: unpaid did not clear paid_at'; end if;
  perform public.set_order_paid(current_setting('pq.o34')::uuid, true);
  raise notice 'paid mark OK';
end $$;

-- 2. Report: the order is held, the report row has the order details, the shop can read it
do $$ declare v_id bigint; r public.file_reports; begin
  begin
    perform public.report_order_files(current_setting('pq.o34')::uuid, 'nonsense', null);
    raise exception 'TEST FAILED: bad reason accepted';
  exception when others then
    if sqlerrm <> 'Please choose a reason' then raise; end if;
  end;
  v_id := public.report_order_files(current_setting('pq.o34')::uuid, 'illegal', '  test note  ');
  select * into r from public.file_reports where id = v_id;
  if r.id is null then raise exception 'TEST FAILED: owner cannot read own report'; end if;
  if r.token is null or array_length(r.paths, 1) <> 1 or r.note <> 'test note' or r.status <> 'open'
     or r.reporter_id <> '00000000-0000-0000-0000-0000000034a1' then
    raise exception 'TEST FAILED: report row not filled: %', row_to_json(r);
  end if;
  if not (select o.hold from public.orders o where o.id = current_setting('pq.o34')::uuid) then
    raise exception 'TEST FAILED: order not held';
  end if;
  if not public.upload_held(r.paths[1]) then raise exception 'TEST FAILED: upload_held false'; end if;
  if (public.reorder_info(current_setting('pq.o34')::uuid, current_setting('pq.k34')::uuid) ->> 'can')::boolean then
    raise exception 'TEST FAILED: held order can be printed again';
  end if;
  -- the shop cannot mark the held files deleted
  begin
    update public.orders set files_deleted = true where id = current_setting('pq.o34')::uuid;
    raise exception 'TEST FAILED: held files could be marked deleted';
  exception when others then
    if sqlerrm <> 'This order is under review. Its files are kept.' then raise; end if;
  end;
  raise notice 'report + hold OK';
end $$;
reset role;

-- 3. Another shop's owner sees no report and cannot report this order
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000034a2", "role": "authenticated"}', true);
set local role authenticated;
do $$ begin
  if exists (select 1 from public.file_reports) then raise exception 'TEST FAILED: other shop reads the report'; end if;
  begin
    perform public.report_order_files(current_setting('pq.o34')::uuid, 'other', null);
    raise exception 'TEST FAILED: other shop could report';
  exception when others then
    if sqlerrm <> 'not allowed' then raise; end if;
  end;
  raise notice 'report access OK';
end $$;
reset role;

-- 4. Cleanup skips the held order even when it is old and done
update public.orders set status = 'done', created_at = now() - interval '30 days' where id = current_setting('pq.o34')::uuid;
do $$ begin
  if exists (select 1 from public.cleanup_candidates() c where c.order_id = current_setting('pq.o34')::uuid) then
    raise exception 'TEST FAILED: held order would lose its files';
  end if;
  update public.orders set hold = false where id = current_setting('pq.o34')::uuid;
  if not exists (select 1 from public.cleanup_candidates() c where c.order_id = current_setting('pq.o34')::uuid) then
    raise exception 'TEST FAILED: released order is not cleaned up';
  end if;
  raise notice 'cleanup skips held OK';
end $$;

rollback;
\echo 'v34 smoke test passed'
