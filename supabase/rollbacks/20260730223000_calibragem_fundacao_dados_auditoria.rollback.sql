-- ROLLBACK: CALIBRAGEM — FUNDAÇÃO DE DADOS E AUDITORIA
-- Remove apenas os objetos novos criados pela migration. Nenhuma tabela
-- existente é afetada.
begin;

drop trigger if exists trg_calibragem_auditoria_no_upd on public.calibragem_auditoria;
drop function if exists public.calibragem_auditoria_append_only();

drop table if exists public.calibragem_auditoria;
drop table if exists public.calibragem_simulacoes;
drop table if exists public.calibragem_parametros;

drop function if exists public.calibragem_e_gestao();

commit;
