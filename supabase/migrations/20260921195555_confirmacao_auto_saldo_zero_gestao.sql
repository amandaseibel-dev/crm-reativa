-- ENCERRAMENTO AUTOMATICO: saldo zero NAO encerra sozinho. Ajuste MINIMO em public.confirmacao_encerrar_uma(uuid).
--
--   PROCESSADO + saldo pendente > 0  => comportamento atual, inalterado (caminho "saldo restante").
--   PROCESSADO + saldo zero          => encerrou=false, estado=PROCESSADO, motivo=SALDO_ZERO_REQUER_CONFIRMACAO_GESTAO; NENHUMA escrita.
-- Motivo (execucao real de 21/09/2026): no saldo zero a rotina seguia o caminho de quitacao e, por gatilhos ja existentes (reposicao de carteira
-- e sincronizacao), liberava o responsavel e enfileirava reposicao. Encerramento automatico nao deve mexer em titularidade: o caso segue para o
-- clique manual da gestao (confirmar_pagamento_solicitacao, INALTERADO), que mantem o efeito atual.
-- Nao altera: confirmar_pagamento_solicitacao, gatilhos de reposicao/sincronizacao, fechar_confirmacao_ao_quitar, casos_reabrir_com_divida,
-- pagamentos, parcelas, acordos, acordos.saldo, D-2. ACL preservada (CREATE OR REPLACE) e reafirmada. Nao liga a flag nem executa a rotina.
begin;
CREATE OR REPLACE FUNCTION public.confirmacao_encerrar_uma(p_confirmacao_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_p jsonb; v_res jsonb; v_old_f text := current_setting('reativa.fluxo_pagamentos', true); v_old_a text := current_setting('reativa.confirmacao_auto', true);
  v_aluno uuid; v_det jsonb;
begin
  v_p := public.confirmacao_pagamento_processado(p_confirmacao_id);
  if v_p->>'estado' is distinct from 'PROCESSADO' or v_p->>'prova' not in ('VINCULO_GRAVADO','CHAVE_MESMA_TRANSACAO') then
    return jsonb_build_object('encerrou', false, 'estado', v_p->>'estado', 'motivo', v_p->>'motivo');
  end if;
  -- SALDO ZERO: encerrar levaria ao caminho de quitacao de confirmar_pagamento_solicitacao (aluno/caso QUITADO, liberacao do responsavel
  -- pelo gatilho de reposicao, fechamento de outras confirmacoes). Isso NAO e decisao do encerramento automatico: fica para a gestao.
  -- Mesma leitura de saldo que confirmar_pagamento_solicitacao usa (somente leitura); sem aluno => tem_pendencia = true (comportamento atual).
  select nullif(s.aluno_id,'')::uuid into v_aluno from public.solicitacoes_confirmacao_pagamento s where s.id = p_confirmacao_id;
  if v_aluno is not null then
    v_det := public.aluno_saldo_pendente_detalhe(v_aluno, p_confirmacao_id);
    if not coalesce((v_det->>'tem_pendencia')::boolean, true) then
      return jsonb_build_object('encerrou', false, 'estado', 'PROCESSADO', 'motivo', 'SALDO_ZERO_REQUER_CONFIRMACAO_GESTAO');
    end if;
  end if;
  perform set_config('reativa.fluxo_pagamentos', 'on', true);
  perform set_config('reativa.confirmacao_auto', 'on', true);
  v_res := public.confirmar_pagamento_solicitacao(p_confirmacao_id, null);
  perform set_config('reativa.fluxo_pagamentos', coalesce(v_old_f, ''), true);
  perform set_config('reativa.confirmacao_auto', coalesce(v_old_a, ''), true);
  return jsonb_build_object('encerrou', coalesce((v_res->>'ja_processado')::boolean, false) = false, 'resultado', v_res);
end;
$function$;

revoke all on function public.confirmacao_encerrar_uma(uuid) from public, anon, authenticated;
grant execute on function public.confirmacao_encerrar_uma(uuid) to service_role;
commit;
