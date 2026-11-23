-- PrintQR v33 (2026-11-23): one row per Razorpay payment, so owners can see and download a receipt
-- for every charge (Dashboard -> Plan -> Payments / receipts).
-- Written only by the Edge Functions (service role): razorpay-webhook on subscription.charged and
-- verify-payment after checkout. payment_id is unique, so repeats of the same payment are ignored.
-- Owners can read their own shop's rows. Safe to run more than once.

create table if not exists public.billing_payments (
  payment_id text primary key,       -- Razorpay pay_... id (unique)
  shop_id uuid not null references public.shops(id) on delete cascade,
  subscription_id text,
  tier text not null default 'pro' check (tier in ('pro', 'plus')),
  period text check (period in ('monthly', 'yearly')),
  amount int not null check (amount >= 0),          -- in paise (4900 = Rs 49)
  currency text not null default 'INR',
  paid_at timestamptz not null default now(),
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists billing_payments_shop on public.billing_payments(shop_id, paid_at desc);

alter table public.billing_payments enable row level security;
drop policy if exists "owner reads payments" on public.billing_payments;
create policy "owner reads payments" on public.billing_payments for select to authenticated
  using (shop_id in (select id from public.shops where owner_id = auth.uid()));

revoke all on public.billing_payments from public, anon, authenticated;
grant select on public.billing_payments to authenticated;
grant select, insert, update, delete on public.billing_payments to service_role;
