-- Rollback de 20260825230000_trava_vinculada_sem_vinculo_e_baixa_no_historico.sql
-- Remove a trava (volta a ser possível gravar "vinculada" sem vínculo) e tira a
-- baixa do histórico. Ver a migration 20260825170000 para a versão anterior da RPC.
drop trigger if exists trg_titulo_normaliza_vinculo_incoerente on public.acordos_titulos;
drop function if exists public.tg_titulo_normaliza_vinculo_incoerente();
