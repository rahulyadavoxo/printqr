-- PrintQR v5 migration (2026-11-18): Dynamic QR for Pro shops.
-- A Pro QR encodes a short code (https://print.receipto.in/#/q/CODE) instead of the shop link.
-- The owner can change which queue the code opens, pause it, and see how many times it was scanned,
-- without re-printing the poster. Free shops keep the plain static link.
-- Safe to run more than once. Paste the whole file in Supabase -> SQL Editor -> New query -> Run.

create table if not exists public.qr_links (
  code text primary key check (code ~ '^[a-z0-9]{6,12}$'),
  shop_id uuid not null references public.shops(id) on delete cascade,
  slot text not null,                       -- 'main' or the counter id this poster was made for
  target_counter_id uuid references public.counters(id) on delete set null,  -- null = main queue
  paused boolean not null default false,
  scans int not null default 0,
  last_scan_at timestamptz,
  created_at timestamptz not null default now(),
  unique (shop_id, slot)
);
create index if not exists qr_links_shop on public.qr_links(shop_id);

alter table public.qr_links enable row level security;

drop policy if exists "owner reads qr links" on public.qr_links;
create policy "owner reads qr links" on public.qr_links for select to authenticated
  using (shop_id in (select id from public.shops where owner_id = auth.uid()));
drop policy if exists "owner updates qr links" on public.qr_links;
create policy "owner updates qr links" on public.qr_links for update to authenticated
  using (shop_id in (select id from public.shops where owner_id = auth.uid()))
  with check (shop_id in (select id from public.shops where owner_id = auth.uid()));

revoke all on public.qr_links from anon, authenticated;
grant select on public.qr_links to authenticated;
grant update (target_counter_id, paused) on public.qr_links to authenticated;
grant all on public.qr_links to service_role;

-- The target counter must belong to the same shop.
create or replace function public.qr_links_check_target()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.target_counter_id is not null and not exists (
    select 1 from public.counters c where c.id = new.target_counter_id and c.shop_id = new.shop_id
  ) then
    raise exception 'Counter not found';
  end if;
  return new;
end $$;
drop trigger if exists qr_links_check_target on public.qr_links;
create trigger qr_links_check_target before insert or update on public.qr_links
  for each row execute function public.qr_links_check_target();

-- Owner gets (or creates) the dynamic code for the main queue (p_counter null) or one counter. Pro only.
create or replace function public.ensure_qr_link(p_shop uuid, p_counter uuid default null)
returns public.qr_links
language plpgsql security definer set search_path = public as $$
declare
  v_shop public.shops;
  v_slot text := coalesce(p_counter::text, 'main');
  v_row public.qr_links;
  v_code text;
begin
  select * into v_shop from public.shops where id = p_shop and owner_id = auth.uid();
  if not found then raise exception 'Shop not found'; end if;

  select * into v_row from public.qr_links where shop_id = p_shop and slot = v_slot;
  if found then return v_row; end if;

  if not public.is_pro(v_shop) then raise exception 'Dynamic QR needs the Pro plan'; end if;
  if p_counter is not null and not exists (select 1 from public.counters where id = p_counter and shop_id = p_shop) then
    raise exception 'Counter not found';
  end if;

  loop
    v_code := substr(md5(random()::text || clock_timestamp()::text || p_shop::text), 1, 7);
    exit when not exists (select 1 from public.qr_links where code = v_code);
  end loop;

  insert into public.qr_links (code, shop_id, slot, target_counter_id)
  values (v_code, p_shop, v_slot, p_counter)
  on conflict (shop_id, slot) do nothing
  returning * into v_row;
  if v_row.code is null then
    select * into v_row from public.qr_links where shop_id = p_shop and slot = v_slot;
  end if;
  return v_row;
end $$;
revoke all on function public.ensure_qr_link(uuid, uuid) from public, anon;
grant execute on function public.ensure_qr_link(uuid, uuid) to authenticated;

-- Customer scan: counts the scan and says where to go. Printed codes keep working even if Pro lapses.
create or replace function public.resolve_qr(p_code text)
returns table (slug text, counter_id uuid, paused boolean)
language plpgsql security definer set search_path = public as $$
begin
  update public.qr_links q set scans = q.scans + 1, last_scan_at = now()
    where q.code = lower(p_code) and not q.paused;
  return query
    select s.slug, q.target_counter_id, q.paused
    from public.qr_links q join public.shops s on s.id = q.shop_id
    where q.code = lower(p_code);
end $$;
revoke all on function public.resolve_qr(text) from public;
grant execute on function public.resolve_qr(text) to anon, authenticated;
