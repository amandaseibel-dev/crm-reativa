-- ACL dos gatilhos da migration 20260922110000 (aplicar DEPOIS dela). Gatilhos so sao invocados pelo motor: sem EXECUTE direto.
begin;
revoke all on function public.tg_acordo_alerta_resolve_parcela() from public, anon, authenticated;
revoke all on function public.tg_acordo_alerta_resolve_acordo() from public, anon, authenticated;
commit;
