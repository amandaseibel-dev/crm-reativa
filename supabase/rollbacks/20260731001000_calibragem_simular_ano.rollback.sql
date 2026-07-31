-- ROLLBACK: CALIBRAGEM — EQUIPARAR POR ANO
begin;
drop function if exists public.calibragem_simular_ano(jsonb);
commit;
