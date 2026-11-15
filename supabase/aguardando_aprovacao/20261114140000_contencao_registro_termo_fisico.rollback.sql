-- REVERSÃO da contenção B1 (PENDENTE). Reconcede EXECUTE a authenticated. Não recria nem apaga nada.
BEGIN;
grant execute on function public.registrar_administrativo_termo_fisico(text, text) to authenticated;
COMMIT;
