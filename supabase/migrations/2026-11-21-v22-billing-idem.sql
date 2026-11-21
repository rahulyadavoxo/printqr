-- PrintQR v22 migration (2026-11-21): billing idempotency. Safe to run more than once.
-- 1. billing_events.event_id must be unique: the webhook now inserts the event first and skips it on a conflict.
--    (v3 created it as the primary key; this only adds a unique index if that is somehow missing.)
-- 2. billing_credits: extra days carried onto a new subscription (unused days of the plan it replaced),
--    written once per subscription id, so repeated webhooks / checkouts never add the days twice.

-- 1
do $$ begin
  if not exists (
    select 1
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
    where i.indrelid = 'public.billing_events'::regclass
      and i.indisunique
      and i.indnkeyatts = 1
      and a.attname = 'event_id'
  ) then
    delete from public.billing_events e
      using public.billing_events d
      where e.event_id = d.event_id and e.ctid > d.ctid;
    create unique index if not exists billing_events_event_id_key on public.billing_events(event_id);
  end if;
end $$;

-- 2
create table if not exists public.billing_credits (
  sub_id text primary key,
  shop_id uuid not null,
  days int not null check (days >= 0),
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists billing_credits_shop on public.billing_credits(shop_id);
alter table public.billing_credits enable row level security;
-- No policies: only the service role (Edge Functions) uses it.
revoke all on public.billing_credits from public, anon, authenticated;
grant all on public.billing_credits to service_role;

notify pgrst, 'reload schema';
