-- PAUSA TEMPORARIA DA ETAPA baixa_pelo_relatorio PARA O BACKFILL #392.
--
-- Autorizada pela gestao em 16/09/2026. Altera SOMENTE a linha
-- 'baixa_pelo_relatorio' de fluxo_pagamentos_config. Nenhuma outra etapa,
-- funcao ou cron e tocada. Motivo: com os 748 boletos restaurados, a rodada
-- horaria baixaria automaticamente os 69 pagamentos AGUARDANDO_AMARRACAO
-- (simulado: 69 BAIXADO, 21 acordos QUITADO) -- e essa fase ainda nao foi
-- autorizada. Religar exige autorizacao expressa da gestao, na fase dos
-- pagamentos. O estado anterior fica preservado na propria observacao.

do $pausa$
declare
  v_antes boolean;
  v_obs text;
  v_outras_antes text;
  v_outras_depois text;
  v_n int;
begin
  select ligado, observacao into v_antes, v_obs
    from public.fluxo_pagamentos_config
   where etapa = 'baixa_pelo_relatorio'
   for update;
  if not found then
    raise exception 'ABORTADO: etapa baixa_pelo_relatorio ausente';
  end if;
  if v_antes is distinct from true then
    raise exception 'ABORTADO: baixa_pelo_relatorio nao esta ligada (ligado=%)', v_antes;
  end if;

  select string_agg(etapa||'|'||ligado::text||'|'||coalesce(observacao,'')||'|'||
                    coalesce(alterado_em::text,'')||'|'||coalesce(alterado_por,''), E'\n' order by etapa)
    into v_outras_antes
    from public.fluxo_pagamentos_config
   where etapa <> 'baixa_pelo_relatorio';

  update public.fluxo_pagamentos_config
     set ligado = false,
         observacao = 'pausado temporariamente para aplicação/auditoria do backfill #392; não religar antes da fase dos pagamentos'
                   || ' | ESTADO ANTERIOR: ligado=' || v_antes::text
                   || ' / observacao anterior: ' || coalesce(v_obs, '(sem)'),
         alterado_em = now(),
         alterado_por = 'protecao_20260916_gestao'
   where etapa = 'baixa_pelo_relatorio'
     and ligado = true;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'ABORTADO: % linhas alteradas, esperado 1', v_n;
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'DESLIGOU_ETAPA_FLUXO', 'fluxo_pagamentos_config', null,
          jsonb_build_object(
            'etapa', 'baixa_pelo_relatorio',
            'ligado_antes', v_antes,
            'ligado_depois', false,
            'motivo', 'pausa temporaria para aplicacao/auditoria do backfill #392; nao religar antes da fase dos pagamentos',
            'observacao_anterior', v_obs));

  -- PROVA: so esta etapa mudou, e as demais estao exatamente no estado exigido
  select string_agg(etapa||'|'||ligado::text||'|'||coalesce(observacao,'')||'|'||
                    coalesce(alterado_em::text,'')||'|'||coalesce(alterado_por,''), E'\n' order by etapa)
    into v_outras_depois
    from public.fluxo_pagamentos_config
   where etapa <> 'baixa_pelo_relatorio';
  if v_outras_depois is distinct from v_outras_antes then
    raise exception 'ABORTADO: outra etapa de fluxo_pagamentos_config mudou';
  end if;

  if (select ligado from public.fluxo_pagamentos_config where etapa = 'baixa_pelo_relatorio') is distinct from false then
    raise exception 'ABORTADO: baixa_pelo_relatorio nao ficou desligada';
  end if;
  if (select ligado from public.fluxo_pagamentos_config where etapa = 'amarrar_boleto') is distinct from true then
    raise exception 'ABORTADO: amarrar_boleto nao esta true';
  end if;
  if (select ligado from public.fluxo_pagamentos_config where etapa = 'pos_importacao') is distinct from true then
    raise exception 'ABORTADO: pos_importacao nao esta true';
  end if;
  if (select ligado from public.fluxo_pagamentos_config where etapa = 'sinalizar_duplicado') is distinct from true then
    raise exception 'ABORTADO: sinalizar_duplicado nao esta true';
  end if;
  if (select ligado from public.fluxo_pagamentos_config where etapa = 'consulta_portador') is distinct from false then
    raise exception 'ABORTADO: consulta_portador nao esta false';
  end if;
  if (select ligado from public.fluxo_pagamentos_config where etapa = 'vinculo_por_negociacao') is distinct from false then
    raise exception 'ABORTADO: vinculo_por_negociacao nao esta false';
  end if;
  if (select ligado from public.fluxo_pagamentos_config where etapa = 'baixa_por_documento') is distinct from false then
    raise exception 'ABORTADO: baixa_por_documento nao esta false';
  end if;
end
$pausa$;
