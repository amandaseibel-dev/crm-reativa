-- ROLLBACK: CALIBRAGEM — SIMULADOR (preview)
begin;
drop function if exists public.calibragem_simular(jsonb);
drop function if exists public.calibragem_indice_equilibrio(numeric[]);
commit;
