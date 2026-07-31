-- ROLLBACK: CALIBRAGEM — EFETIVIDADE
begin;
drop function if exists public.calibragem_efetividade(date,date,text);
drop index if exists public.idx_aluno_mov_reg_por;
drop index if exists public.idx_aluno_mov_registrado_em;
commit;
