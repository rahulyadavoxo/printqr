-- v15: push-new-order (service_role) was getting 403 on push_tokens because v14 revoked all from public.
grant select, delete on public.push_tokens to service_role;
