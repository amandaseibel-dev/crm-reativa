-- Rollback de 20260826030000_parcela_pago_em_automatico.sql
--
-- Remove o gatilho e devolve `pago_em` a NULO SOMENTE nas parcelas marcadas
-- pelo backfill. As 1.270 parcelas que já tinham data de verdade não são
-- tocadas -- o filtro é a assinatura na observação, não o status.
--
-- Reverter recria o buraco: R$ 723.433,49 de liquidação volta a ficar fora de
-- qualquer recorte por período.

drop trigger if exists trg_parcela_pago_em_automatico on public.parcelas;
drop function if exists public._parcela_pago_em_automatico();

update public.parcelas
   set pago_em = null,
       observacao = nullif(
         btrim(
           regexp_replace(
             coalesce(observacao, ''),
             '\s*\|?\s*data de pagamento inferida da atualizacao do registro \(backfill_pago_em_20260826\)',
             '', 'g'
           ),
           ' |'
         ), ''
       )
 where observacao like '%backfill_pago_em_20260826%';
