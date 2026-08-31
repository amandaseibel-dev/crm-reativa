-- DESFAZER 20260831180000_vincular_titulo_recalcula_saldo_na_hora.sql
--
-- ATENCAO: desfazer faz a mensalidade vinculada continuar somando no saldo ate
-- a virada das 06:00 -- a mesma divida contada duas vezes, uma na parcela do
-- acordo e outra no titulo. Foi exatamente a queixa da Amanda em 31/08.

drop trigger if exists trg_recalc_vinculo_ins on public.acordo_titulo_vinculo;
drop trigger if exists trg_recalc_vinculo_upd on public.acordo_titulo_vinculo;
drop function if exists public._trg_recalc_por_vinculo_novo();
