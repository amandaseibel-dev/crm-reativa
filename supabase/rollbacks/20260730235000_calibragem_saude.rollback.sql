-- ROLLBACK: CALIBRAGEM — SAÚDE DA CARTEIRA
begin;
drop function if exists public.calibragem_saude(text);
commit;
