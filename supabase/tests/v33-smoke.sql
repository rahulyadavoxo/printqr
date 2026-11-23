-- Smoke test for v33 billing_payments (CI only, throw-away local Supabase). Rolled back at the end.
\set ON_ERROR_STOP 1
begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000033a1', 'owner-a-v33@example.com'),
  ('00000000-0000-0000-0000-0000000033a2', 'owner-b-v33@example.com');
insert into public.shops (id, owner_id, name, slug) values
  ('00000000-0000-0000-0000-0000000033b1', '00000000-0000-0000-0000-0000000033a1', 'Shop A', 'shop-a-v33'),
  ('00000000-0000-0000-0000-0000000033b2', '00000000-0000-0000-0000-0000000033a2', 'Shop B', 'shop-b-v33');

-- What the Edge Functions do (service role): upsert on payment_id, twice for the same payment.
set local role service_role;
insert into public.billing_payments (payment_id, shop_id, subscription_id, tier, period, amount, paid_at)
  values ('pay_v33test', '00000000-0000-0000-0000-0000000033b1', 'sub_v33', 'pro', 'yearly', 53900, now())
  on conflict (payment_id) do update set amount = excluded.amount;
insert into public.billing_payments (payment_id, shop_id, subscription_id, tier, period, amount)
  values ('pay_v33test', '00000000-0000-0000-0000-0000000033b1', 'sub_v33', 'pro', 'yearly', 53900)
  on conflict (payment_id) do update set amount = excluded.amount;
reset role;

do $$ begin
  if (select count(*) from public.billing_payments where payment_id = 'pay_v33test') <> 1 then
    raise exception 'TEST FAILED: payment stored more than once';
  end if;
end $$;

-- Owner A sees their payment
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000033a1","role":"authenticated"}', true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.billing_payments) <> 1 then raise exception 'TEST FAILED: owner cannot see own payment'; end if;
end $$;
-- ...but cannot write
do $$ begin
  begin
    insert into public.billing_payments (payment_id, shop_id, amount) values ('pay_fake', '00000000-0000-0000-0000-0000000033b1', 1);
    raise exception 'TEST FAILED: owner could insert a payment';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Owner B sees nothing of A's
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000033a2","role":"authenticated"}', true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.billing_payments) <> 0 then raise exception 'TEST FAILED: owner sees another shop''s payment'; end if;
end $$;
reset role;

-- Anonymous visitors see nothing
set local role anon;
do $$ begin
  begin
    perform 1 from public.billing_payments;
    raise exception 'TEST FAILED: anon can read payments';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
\echo 'v33 smoke test OK'
