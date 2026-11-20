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

-- v18 (part 2): owner / staff new-order push only in the language each phone or browser uses.
-- The app sends its current language with the push token (and again when the language is switched).
alter table public.push_tokens add column if not exists lang text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'push_tokens_lang_check') then
    alter table public.push_tokens add constraint push_tokens_lang_check check (lang is null or lang in ('en', 'hi'));
  end if;
end $$;

-- Same name, one more optional argument. The old 2-argument version is replaced (not overloaded) so
-- older apps that call register_push_token(p_token, p_platform) still resolve to this one; their lang
-- stays as it was (null = both languages, as before).
drop function if exists public.register_push_token(text, text);
create or replace function public.register_push_token(p_token text, p_platform text default 'android', p_lang text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_lang text := case when p_lang in ('en', 'hi') then p_lang else null end;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if p_token is null or length(p_token) < 20 or length(p_token) > 4096 then
    raise exception 'Bad push token' using errcode = '22023';
  end if;
  insert into public.push_tokens (token, owner_id, platform, lang)
  values (p_token, auth.uid(), left(coalesce(nullif(p_platform, ''), 'android'), 20), v_lang)
  on conflict (token) do update set owner_id = excluded.owner_id, platform = excluded.platform,
    lang = coalesce(excluded.lang, public.push_tokens.lang), updated_at = now();
  -- Keep the 10 newest phones per owner.
  delete from public.push_tokens
  where owner_id = auth.uid()
    and token not in (select token from public.push_tokens where owner_id = auth.uid() order by updated_at desc limit 10);
end $$;
revoke all on function public.register_push_token(text, text, text) from public, anon;
grant execute on function public.register_push_token(text, text, text) to authenticated;

notify pgrst, 'reload schema';
