-- ROLLBACK: CALIBRAGEM — SNAPSHOT E VISÃO POR OPERADOR
begin;
drop function if exists public.calibragem_visao_operadores();
drop function if exists public.calibragem_recomputar_snapshot();
drop view if exists public.calibragem_saldo_aluno;
drop table if exists public.calibragem_snapshot_operador;
drop table if exists public.calibragem_snapshot_meta;
commit;
