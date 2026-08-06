-- Rollback: remove a simulação "500 casos + saldo equilibrado"
begin;
drop function if exists public.calibragem_simular_500(jsonb);
commit;
