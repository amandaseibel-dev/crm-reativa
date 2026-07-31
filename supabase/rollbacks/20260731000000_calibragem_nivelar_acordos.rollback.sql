-- ROLLBACK: CALIBRAGEM — NIVELAR ACORDOS
begin;
drop function if exists public.calibragem_executar_acordos(uuid);
drop function if exists public.calibragem_simular_acordos(jsonb);
commit;
