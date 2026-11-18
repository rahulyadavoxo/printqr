-- PrintQR v10 (2026-11-18): no CAPTCHA on customer orders (owner's choice).
-- Re-opens the normal order entry point. v7 IP + per-shop rate limits still apply.
-- create_order_checked stays so app v1.4.8 keeps working.
grant execute on function public.create_order(text, text, text, jsonb, uuid) to anon, authenticated;
notify pgrst, 'reload schema';
