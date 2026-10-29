-- ROLLBACK de 20260922310000_baixa_legado_50611040003.sql
--
-- Devolve a parcela 3 do acordo 475 (boleto 50611040003) ao estado exato de
-- antes: VENCIDA, `pago_em` nulo, `confirmado_por_email` nulo e a observacao
-- original, sem a linha de procedencia que a migration acrescentou. Ou seja:
-- reabre o caso, e o pagamento de R$ 297,61 volta a ficar sem aplicacao.
--
-- SOBRE O DELETE, que aqui e deliberado e excepcional: a casa nao apaga baixa,
-- porque baixa e historia de uma operacao real. Esta linha e diferente -- ela
-- nao existia antes desta migration, foi criada por ela, e e identificada sem
-- ambiguidade por `baixado_por_email = 'correcao-legado@sistema'` mais a
-- parcela, o valor e a data. Marca-la como DEVOLVIDA em vez de apagar deixaria
-- na ficha do aluno um estorno que nunca aconteceu -- narrativa falsa, pior que
-- a remocao. O rollback confere que existe EXATAMENTE UMA linha com essa
-- assinatura e aborta se houver qualquer outra coisa.
--
-- NAO TOCA: nenhuma outra parcela, nenhum outro pagamento, nenhum aluno,
-- nenhum acordo, nenhuma outra baixa. Nenhum gatilho e desabilitado -- o
-- recalculo do aluno roda de novo, como deve, porque a parcela volta a VENCIDA.

do $undo$
declare
  v_parcela_id uuid := 'c411e507-b24a-4017-828d-5b93ee9210a1';
  v_autor      text := 'correcao-legado@sistema';
  v_obs_antes  text := 'baixa em 01/09/2026 pelo documento: pago R$ 297.61 para parcela de R$ 291.48 -- diferenca e juros e multa';
  v_n int;
begin
  -- 1) so reverte o que ESTA migration criou
  select count(*) into v_n
    from public.baixas_pagamento
   where parcela_id = v_parcela_id
     and baixado_por_email = v_autor
     and round(valor_pago,2) = 297.61
     and data_pagamento = date '2026-08-17';
  if v_n <> 1 then
    raise exception 'ROLLBACK ABORTADO: encontrei % baixas com a assinatura da correcao de legado, esperada 1.', v_n;
  end if;

  select count(*) into v_n from public.baixas_pagamento where parcela_id = v_parcela_id;
  if v_n <> 1 then
    raise exception 'ROLLBACK ABORTADO: a parcela tem % baixas no total, esperada 1. Apareceu baixa nova -- confira antes de reverter.', v_n;
  end if;

  -- 2) a parcela volta ao estado anterior
  update public.parcelas
     set status = 'VENCIDA',
         pago_em = null,
         confirmado_por_email = null,
         observacao = v_obs_antes,
         atualizado_em = now()
   where id = v_parcela_id;

  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'ROLLBACK ABORTADO: o update da parcela alcancou % linhas, esperada 1.', v_n;
  end if;

  -- 3) a linha criada por esta frente sai
  delete from public.baixas_pagamento
   where parcela_id = v_parcela_id
     and baixado_por_email = v_autor
     and round(valor_pago,2) = 297.61
     and data_pagamento = date '2026-08-17';

  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'ROLLBACK ABORTADO: o delete alcancou % linhas, esperada 1.', v_n;
  end if;

  -- 4) resultado
  select count(*) into v_n from public.baixas_pagamento where parcela_id = v_parcela_id;
  if v_n <> 0 then
    raise exception 'ROLLBACK ABORTADO: sobraram % baixas na parcela, esperadas 0.', v_n;
  end if;

  select count(*) into v_n from public.parcelas
   where id = v_parcela_id and status = 'VENCIDA' and pago_em is null;
  if v_n <> 1 then
    raise exception 'ROLLBACK ABORTADO: a parcela nao voltou para VENCIDA sem pago_em.';
  end if;

  raise notice 'ROLLBACK OK: boleto 50611040003 voltou a VENCIDA, sem baixa.';
end;
$undo$;
