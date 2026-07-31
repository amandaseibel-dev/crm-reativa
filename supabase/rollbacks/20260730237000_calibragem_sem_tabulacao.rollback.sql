-- ROLLBACK: CALIBRAGEM — ATENDIMENTO SEM TABULAÇÃO
begin;
drop function if exists public.calibragem_atendimentos_sem_tabulacao(int);
commit;
