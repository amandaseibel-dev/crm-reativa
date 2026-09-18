-- LIGA a recuperacao automatica do acordo a vista (18/09/2026), depois do
-- lote 1 (14 recuperados, 0 erros, invariantes ok) e da segunda passada
-- idempotente (0 recuperados, 0 erros).
do $liga$
begin
  if (select ligado from public.fluxo_pagamentos_config where etapa = 'recuperar_acordo_avista') is distinct from false then
    raise exception 'ATIVACAO: etapa ausente ou ja ligada';
  end if;
  if (select count(*) from public.fluxo_pagamentos_execucoes
       where origem in ('rollout_recuperacao_avista_lote_1', 'rollout_recuperacao_avista_lote_2')) <> 2 then
    raise exception 'ATIVACAO: lotes de validacao nao encontrados';
  end if;
  if (select (resultado -> 'rotina' ->> 'erros')::int + (resultado -> 'rotina' ->> 'recuperados')::int
        from public.fluxo_pagamentos_execucoes where origem = 'rollout_recuperacao_avista_lote_2' order by id desc limit 1) <> 0 then
    raise exception 'ATIVACAO: a segunda passada nao foi idempotente';
  end if;
  if exists (select 1 from cron.job where jobname = 'reposicao_carteira_minuto' and active) then
    raise exception 'ATIVACAO: a reposicao deveria continuar pausada';
  end if;

  update public.fluxo_pagamentos_config
     set ligado = true, alterado_em = now(), alterado_por = 'ativacao_20260918_gestao',
         observacao = 'LIGADA em 18/09/2026 apos lote 1 (14 recuperados, 0 erros) e segunda passada idempotente. Recupera o acordo a vista pago antes da importacao: a previa do botao aprova, o registrador da gestao grava e o motor baixa. Desligar aqui para a recuperacao sem parar importacao, baixa, reconstrucao nem as outras etapas.'
   where etapa = 'recuperar_acordo_avista';

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'LIGOU_ETAPA_FLUXO', 'fluxo_pagamentos_config', null,
          jsonb_build_object('etapa', 'recuperar_acordo_avista', 'ligado_antes', false, 'ligado_depois', true,
            'motivo', 'ativacao apos lote 1 (14 recuperados, 0 erros, invariantes ok) e segunda passada idempotente (PR #410, migration 20260918094733)'));
end;
$liga$;
