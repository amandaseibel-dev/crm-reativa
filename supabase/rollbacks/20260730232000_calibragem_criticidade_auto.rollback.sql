-- ROLLBACK: CALIBRAGEM — CRITICIDADE AUTOMÁTICA
begin;
drop function if exists public.calibragem_criticidade_auto();
drop function if exists public.calibragem_nivel_criticidade(int,int,numeric,boolean,boolean,jsonb);
-- (os parâmetros criticidade_regras permanecem; não são destrutivos)
commit;
