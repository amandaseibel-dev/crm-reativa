-- ROLLBACK de 20260922110100 (devolve EXECUTE default; nao recomendado).
begin;
grant execute on function public.tg_acordo_alerta_resolve_parcela(), public.tg_acordo_alerta_resolve_acordo() to public, anon, authenticated;
commit;
