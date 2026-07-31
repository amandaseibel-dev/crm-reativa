-- ROLLBACK: CALIBRAGEM — FUNIL
begin;
drop function if exists public.calibragem_funil(text);
commit;
