-- PrintQR v18 (2026-11-20): the customer's "order ready" notification comes only in the language
-- the customer placed the order in. The upload page saves it on the order right after create_order.
alter table public.orders add column if not exists lang text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_lang_check') then
    alter table public.orders add constraint orders_lang_check check (lang is null or lang in ('en', 'hi'));
  end if;
end $$;

create or replace function public.set_order_lang(p_order_id uuid, p_key uuid, p_lang text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_lang not in ('en', 'hi') then raise exception 'Bad language'; end if;
  update public.orders set lang = p_lang
   where id = p_order_id and access_key = p_key and status in ('uploading', 'received');
end $$;
revoke all on function public.set_order_lang(uuid, uuid, text) from public;
grant execute on function public.set_order_lang(uuid, uuid, text) to anon, authenticated;

notify pgrst, 'reload schema';
