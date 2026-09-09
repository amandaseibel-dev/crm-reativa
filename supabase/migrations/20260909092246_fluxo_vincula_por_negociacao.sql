-- ETAPA 5 DO FLUXO: o acordo passa a dizer de onde veio, sozinho.
--
-- `prime_vincular_por_negociacao` existia, escrita e cuidadosa (modo de previa,
-- backup automatico, motivo gravado em cada titulo) -- e NUNCA era chamada. Nem
-- cron, nem funcao, nem tela. Por isso 1.319 acordos ativos estavam cegos: nao
-- diziam qual divida substituiram, R$ 5,42 milhoes sem origem conhecida.
--
-- Ela infere o vinculo pelo Prime: agrupa as liquidacoes do portador 195 por
-- matricula e data e casa com o acordo criado logo depois.
--
-- TOLERANCIA DE 3 DIAS, decidida em 09/09 depois de ver a curva: 3 dias casa
-- 715 grupos (193 titulos, R$ 103.196,41); 15 dias casa 1.398 (420 titulos,
-- R$ 286.178,64). Tres dias exige que o acordo tenha nascido quase junto com a
-- liquidacao -- e o corte que nao inventa relacao.
--
-- Rodada uma vez a mao em 09/09: 193 vinculos, 102 alunos, backup
-- _backup_vinc_negociacao_20260909091930. A carteira caiu R$ 103.196,41, que e
-- correcao de dupla representacao -- o titulo sai porque a divida passa a ser
-- as parcelas do acordo.
--
-- ENTRA COMO ETAPA CONFIGURAVEL, seguindo o padrao da casa: uma linha em
-- fluxo_pagamentos_config com liga/desliga proprio. Desligar e um update, nao
-- um deploy. Fica por ULTIMO: as etapas existentes nao mudam de comportamento.
--
-- NOTA DE PERCURSO: a primeira tentativa alterou fluxo_pagamentos_executar,
-- que NAO e quem o cron chama. Quem roda de hora em hora e
-- fluxo_pagamentos_rodar. As duas foram ajustadas.
insert into public.fluxo_pagamentos_config (etapa, ligado, observacao, alterado_em, alterado_por)
values ('vinculo_por_negociacao', true,
        'Infere pelo Prime qual divida o acordo substituiu (portador 195, tolerancia 3 dias). Sem isto o acordo importado nao diz de onde veio.',
        now(), 'migration_09_09_2026')
on conflict (etapa) do update
   set ligado = true, observacao = excluded.observacao,
       alterado_em = now(), alterado_por = excluded.alterado_por;

create or replace function public.fluxo_pagamentos_rodar(p_origem text default 'cron'::text)
 returns jsonb
 language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_antes numeric; v_depois numeric; v_res jsonb := '{}'::jsonb;
  v_liga boolean; v_carga jsonb; v_erro text;
begin
  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean,false) then
    insert into public.fluxo_pagamentos_execucoes (origem, resultado)
    values (p_origem, jsonb_build_object('pulou','sistema sob carga'));
    return jsonb_build_object('pulou','sistema sob carga');
  end if;

  perform set_config('reativa.fluxo_pagamentos','on', true);
  select round(coalesce(sum(saldo_total),0),2) into v_antes from public.alunos;

  begin
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='amarrar_boleto';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('amarrar_boleto', public.parcelas_amarrar_boleto());
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='pos_importacao';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('pos_importacao', public.acordos_pos_importacao(null, true));
    end if;

    -- le o numero no pagamento, grava na parcela e baixa
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='baixa_pelo_relatorio';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('baixa_pelo_relatorio', public.baixa_pelo_relatorio_pagamento(true, (current_date - 180)));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='baixa_por_documento';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('baixa', public.baixa_por_documento_aplicar('2026-07-01', true));
    else
      v_res := v_res || jsonb_build_object('baixa_previa', public.baixa_por_documento_aplicar('2026-07-01', false));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='sinalizar_duplicado';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('duplicados', public.acordos_sinalizar_boleto_repetido());
    end if;

    -- O acordo diz de onde veio. Por ultimo: nao altera as etapas acima.
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='vinculo_por_negociacao';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('vinculo_por_negociacao', public.prime_vincular_por_negociacao(true, 3));
    end if;
  exception when others then
    v_erro := SQLERRM;
  end;

  select round(coalesce(sum(saldo_total),0),2) into v_depois from public.alunos;
  insert into public.fluxo_pagamentos_execucoes (origem, carteira_antes, carteira_depois, resultado, erro)
  values (p_origem, v_antes, v_depois, v_res, v_erro);

  return jsonb_build_object('carteira_antes',v_antes,'carteira_depois',v_depois,
    'variacao', round(v_depois-v_antes,2), 'etapas', v_res, 'erro', v_erro);
end;
$function$;
