-- PrintQR v43 (2026-11-24): new support message -> admin bell + push.
-- support_submit() opens an ops_alerts row 'support_<ticket id>' (the admin bell counts open alerts) and asks the
-- health-check function to push it to every admin device now; tapping the push opens Admin > Support.
-- admin_support_reply() closes that alert when the message gets a reply or is marked solved.
-- Idempotent. Needs v30 (ops_alerts), v39 (support tickets).

create or replace function public.support_submit(p_topic text, p_message text, p_app text default null)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare v_shop uuid := public.my_shop_id(); v_id bigint; v_name text; v_tok text;
begin
  if v_shop is null then raise exception 'not allowed'; end if;
  if char_length(trim(coalesce(p_message, ''))) < 3 then raise exception 'message too short'; end if;
  if (select count(*) from public.support_tickets where shop_id = v_shop and created_at > now() - interval '1 day') >= 5 then
    raise exception 'too many requests';
  end if;
  insert into public.support_tickets (shop_id, user_id, topic, message, app)
  values (v_shop, auth.uid(), case when p_topic in ('problem', 'feedback', 'billing', 'other') then p_topic else 'other' end,
          left(trim(p_message), 2000), left(nullif(trim(p_app), ''), 120))
  returning id into v_id;
  -- v43: an open alert per message: the admin bell counts it, every admin phone / browser gets a push
  select name into v_name from public.shops where id = v_shop;
  insert into public.ops_alerts (key, title, detail)
  values ('support_' || v_id, 'New support message',
          left(coalesce(v_name, 'A shop') || ': ' || left(trim(p_message), 200), 300))
  on conflict do nothing;
  -- tell every admin device at once (health-check push-only mode); without pg_net / token the 15-minute run sends it
  begin
    select token into v_tok from private.cron_tokens where name = 'health';
    if v_tok is not null then
      perform net.http_post(
        url := 'https://asqgdgzxkdksoikmffmd.supabase.co/functions/v1/health-check',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-token', v_tok),
        body := '{"mode":"push"}'::jsonb,
        timeout_milliseconds := 30000);
    end if;
  exception when others then null;
  end;
  return v_id;
end $$;
revoke all on function public.support_submit(text, text, text) from public, anon;
grant execute on function public.support_submit(text, text, text) to authenticated;

create or replace function public.admin_support_reply(p_id bigint, p_reply text default null, p_status text default null)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_t public.support_tickets; v_reply text := left(nullif(trim(p_reply), ''), 2000);
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if p_status is not null and p_status not in ('open', 'solved') then raise exception 'bad status'; end if;
  select * into v_t from public.support_tickets where id = p_id for update;
  if not found then raise exception 'not found'; end if;
  update public.support_tickets set
    reply = coalesce(v_reply, reply),
    replied_at = case when v_reply is not null then now() else replied_at end,
    replied_by = case when v_reply is not null then auth.uid() else replied_by end,
    status = coalesce(p_status, status),
    updated_at = now()
  where id = p_id;
  -- v43: answered or solved -> the bell alert for this message closes
  if v_reply is not null or p_status = 'solved' then
    update public.ops_alerts set closed_at = now() where key = 'support_' || p_id and closed_at is null;
  end if;
  if v_reply is not null then
    insert into public.shop_notices (shop_id, kind, title, body, data, created_by)
    values (v_t.shop_id, 'support', null, v_reply, jsonb_build_object('ticket', p_id, 'question', left(v_t.message, 200)), auth.uid());
  end if;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), 'support_reply', v_t.shop_id, jsonb_build_object('ticket', p_id, 'replied', v_reply is not null, 'status', coalesce(p_status, v_t.status)));
end $$;
revoke all on function public.admin_support_reply(bigint, text, text) from public, anon;
grant execute on function public.admin_support_reply(bigint, text, text) to authenticated;

-- Messages already waiting (sent before v43) get their alert too, without a push.
insert into public.ops_alerts (key, title, detail, notified_at)
select 'support_' || t.id, 'New support message', left(coalesce(s.name, 'A shop') || ': ' || left(t.message, 200), 300), now()
from public.support_tickets t left join public.shops s on s.id = t.shop_id
where t.status = 'open' and t.reply is null
  and not exists (select 1 from public.ops_alerts a where a.key = 'support_' || t.id)
on conflict do nothing;
