-- CARDINALIDADE DE MENSALIDADES NAO E CRITERIO DE RISCO FINANCEIRO.
--
-- SUBSTITUI a regra de elegibilidade introduzida em
-- 20260922270000_reacordo_saldo_residual_deterministico.sql, que exigia
-- EXATAMENTE 1 mensalidade no vinculo historico para considerar o residual
-- confiavel (motivo RESIDUAL_MULTIPLOS_TITULOS). Aquela migration NAO CHEGOU A
-- SER APLICADA em producao -- a auditoria que autorizaria a aplicacao derrubou
-- o criterio antes disso. Ela nao pode ser editada no lugar porque ja esta no
-- branch base e a catraca das migrations trata migration publicada como
-- imutavel (I1-MIGRATION-ALTERADA); dai esta migration nova, que roda logo
-- depois dela e redefine as duas funcoes. Aplicar as duas na mesma janela: o
-- estado intermediario existe so entre um CREATE OR REPLACE e o outro, e nao
-- escreve dado nenhum (as duas so definem funcao).
--
-- POR QUE O CRITERIO ESTAVA ERRADO (auditoria somente leitura em producao,
-- 22/09/2026):
--
--   1. O residual e uma propriedade do ACORDO, nao da mensalidade. Ele sai de
--      SUM(parcelas CANCELADA) e nao depende de quantas mensalidades entraram
--      na negociacao: um acordo com 3 mensalidades de origem tem residual tao
--      determinavel quanto um com 1. O que seria aproximacao e REPARTIR esse
--      residual entre elas -- e nada aqui reparte. `vincular_titulos_acordo`
--      nao grava valor por titulo (so troca situacao/status e cria a linha do
--      vinculo) e `acordo_saldo_residual` devolve o total do acordo. O risco
--      que a exigencia tentava cobrir e outro, e agora esta no lugar certo:
--      RE-ACORDO PARCIAL (bloco 2).
--
--   2. A medicao mostrou que a exigencia barrava a populacao errada. Dos 479
--      acordos classificados como RESIDUAL_MULTIPLOS_TITULOS, apenas 10 tinham
--      mesmo mais de um titulo: 469 tinham ZERO linha de vinculo -- 463 sem
--      titulo algum (R$ 1.953.053,32) e 6 so com titulo ja PAGO -- orfaos do
--      DELETE que o `cancelar_acordo_ficha` antigo fazia, ate 20260922265000.
--      E os 10 legitimos nem alcancam esta regra: seus titulos ja voltaram a
--      ABERTO com acordo_id nulo pela regra antiga, entao passam pelo caminho
--      normal de vinculacao. Nenhum dos 479 era um bloqueio real.
--
--      Olhando pra frente e o inverso. Dos acordos ATIVO de hoje, 922
--      (R$ 6,42 mi de valor_total) tem 2+ mensalidades no vinculo ativo contra
--      322 (R$ 958.821,67) com exatamente 1. Simulando o cancelamento de todos
--      eles com a estrutura de hoje, a regra nova deixa 357 acordos
--      multi-titulo ELEGIVEIS (R$ 2.251.404,99 de residual) -- 79% de todo o
--      residual elegivel. Sob a exigencia de cardinalidade, os 357 estariam
--      bloqueados sem nenhuma razao financeira.
--
-- ZERO VINCULO GANHA MOTIVO PROPRIO: `v_titulos = 0` nao quer dizer que o
-- residual esteja errado -- ele continua matematicamente conhecido e vai no
-- retorno. Quer dizer que o CRM nao tem a cadeia historica (mensalidade ->
-- acordo cancelado) necessaria pra um re-acordo automatico seguro. Motivo
-- RESIDUAL_SEM_VINCULO_HISTORICO, `confiavel` false: nao se inventa titulo de
-- origem nem se reconstroi vinculo por aproximacao. Os 464 orfaos historicos
-- ficam sinalizados e fora da automacao, sem saneamento nenhum aqui.
--
-- ORDEM DAS CHECAGENS: RESIDUAL_ZERO vem ANTES de SEM_VINCULO_HISTORICO de
-- proposito. "Nao ha saldo residual" e verdade independentemente da cadeia; se
-- nao ha o que renegociar, a falta do vinculo e irrelevante e a mensagem util
-- pra quem opera e a primeira.
--
-- O QUE ESTA MIGRATION NAO FAZ: nao aplica backfill nem saneamento, nao toca
-- nos 464 orfaos, nao mexe em 20260922265000 (ja em producao e validada), nao
-- cria coluna -- `acordo_anterior_id` e dispensavel porque a sequencia
-- cronologica da cadeia sai inteira de acordo_titulo_vinculo + criado_em, o
-- que tem teste proprio.

-- ---------------------------------------------------------------------------
-- 1) acordo_saldo_residual: cardinalidade sai; zero-vinculo ganha motivo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.acordo_saldo_residual(p_acordo_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_valor_total numeric;
  v_pago numeric; v_cancelado numeric; v_n int; v_titulos int;
begin
  select valor_total into v_valor_total from public.acordos where id = p_acordo_id;
  if v_valor_total is null then
    return jsonb_build_object('confiavel', false, 'residual', null,
      'motivo', 'RESIDUAL_ACORDO_NAO_ENCONTRADO');
  end if;

  select count(*),
         coalesce(sum(valor) filter (where status = 'PAGO'), 0),
         coalesce(sum(valor) filter (where status = 'CANCELADA'), 0)
    into v_n, v_pago, v_cancelado
    from public.parcelas where acordo_id = p_acordo_id;

  select count(distinct titulo_id) into v_titulos
    from public.acordo_titulo_vinculo where acordo_id = p_acordo_id;

  if v_n = 0 then
    return jsonb_build_object('confiavel', false, 'residual', null,
      'motivo', 'RESIDUAL_DIVERGENCIA_ESTRUTURAL',
      'detalhe', 'acordo cancelado sem nenhuma parcela');
  end if;

  if abs(round(v_pago + v_cancelado, 2) - round(v_valor_total, 2)) >= 0.02 then
    if v_pago = 0 then
      return jsonb_build_object('confiavel', false, 'residual', null,
        'motivo', 'RESIDUAL_DIVERGENCIA_ESTRUTURAL',
        'detalhe', 'parcelas canceladas nao somam o valor_total do acordo, sem nenhum pagamento registrado');
    else
      return jsonb_build_object('confiavel', false, 'residual', null,
        'motivo', 'RESIDUAL_PAGAMENTO_FORA_DA_ESTRUTURA',
        'detalhe', 'existe pagamento que nao reconcilia com valor_total - parcelas canceladas');
    end if;
  end if;

  if round(v_cancelado, 2) <= 0 then
    return jsonb_build_object('confiavel', false, 'residual', 0,
      'motivo', 'RESIDUAL_ZERO', 'titulos', v_titulos,
      'detalhe', 'nao ha saldo residual: nada a renegociar');
  end if;

  -- Residual conhecido, mas sem cadeia historica pra ancorar o re-acordo.
  -- O numero vai no retorno (ele esta certo); o que nao da e automatizar a
  -- renegociacao sem saber de qual mensalidade essa divida veio.
  if v_titulos = 0 then
    return jsonb_build_object('confiavel', false, 'residual', round(v_cancelado, 2),
      'motivo', 'RESIDUAL_SEM_VINCULO_HISTORICO', 'titulos', 0,
      'detalhe', 'acordo cancelado sem nenhuma linha em acordo_titulo_vinculo -- '
                 || 'o residual e conhecido, mas nao ha mensalidade de origem '
                 || 'registrada pra ancorar um re-acordo automatico');
  end if;

  -- Varias mensalidades de origem NAO tornam o residual do acordo incerto: ele
  -- e do acordo, nao de cada uma. Quem impede o re-acordo PARCIAL (levar parte
  -- dos titulos e deixar o resto orfao do mesmo residual) e
  -- vincular_titulos_acordo, na regra tudo-ou-nada.
  return jsonb_build_object('confiavel', true, 'residual', round(v_cancelado, 2),
                            'motivo', null, 'titulos', v_titulos);
end;
$function$;

comment on function public.acordo_saldo_residual(uuid) is
  'Saldo residual deterministico de um acordo CANCELADO: SUM(parcelas CANCELADA), quando pago+cancelado reconcilia com valor_total. A QUANTIDADE de mensalidades de origem nao afeta a confiabilidade -- o residual e do ACORDO e nunca e repartido entre elas. confiavel=false com motivo RESIDUAL_DIVERGENCIA_ESTRUTURAL / RESIDUAL_PAGAMENTO_FORA_DA_ESTRUTURA / RESIDUAL_ZERO / RESIDUAL_SEM_VINCULO_HISTORICO (residual conhecido, cadeia historica ausente) -- nunca aproxima.';

grant execute on function public.acordo_saldo_residual(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) vincular_titulos_acordo: a protecao vai para o risco verdadeiro --
--    RE-ACORDO PARCIAL. Se o acordo cancelado A negociava T1+T2+T3, levar so
--    T1+T2 pro acordo novo deixaria T3 orfao do MESMO residual, e ai sim
--    alguem teria de repartir por aproximacao depois. Ou vem a cadeia inteira
--    de A, ou a operacao volta sem escrever nada.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_aluno_acordo uuid;
  v_status_acordo text;
  v_numero text;
  v_quitado boolean;
  v_bloqueados uuid[];
  v_novos uuid[];
  v_ja int := 0;
  v_n int := 0;
  v_reparo uuid[];
  v_faltando uuid[];
  v_conflitos jsonb;
  v_criados int := 0;
  v_sem_amarra int := 0;
  v_reacordo_parcial jsonb;
begin
  -- A ETAPA AUTOMATICA DO ACORDO A VISTA assina como sistema. A porta e a
  -- mesma de `acordo_avista_registrar`: chave transacional + pilha de chamada.
  -- Esta funcao tem um unico chamador, o registrador do acordo a vista.
  if v_email = '' and public.acordo_avista_porta_interna() then
    v_email := 'conciliacao@sistema';
  end if;
  if v_email = '' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  if p_acordo_id is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;
  if p_titulo_ids is null or array_length(p_titulo_ids,1) is null then
    return jsonb_build_object('ok',false,'erro','SEM_TITULOS');
  end if;

  -- Cadeado sem fila: se o acordo esta em uso, volta agora, sem ter escrito
  -- nada. Antes esperava e morria nos 8s -- sem saber se gravou ou nao.
  if not pg_try_advisory_xact_lock(hashtextextended(p_acordo_id::text, 0)) then
    return jsonb_build_object('ok',false,'erro','ACORDO_EM_USO');
  end if;

  select aluno_id, upper(coalesce(status,'')), coalesce(numero_acordo::text,'')
    into v_aluno_acordo, v_status_acordo, v_numero
  from public.acordos where id = p_acordo_id;
  if v_aluno_acordo is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;

  if v_status_acordo = 'CANCELADO' then
    return jsonb_build_object('ok',false,'erro','acordo_cancelado_operacao_nao_permitida');
  elsif v_status_acordo not in ('ATIVO','QUITADO') then
    return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ATIVO');
  end if;

  perform 1 from public.acordos_titulos where id = any(p_titulo_ids) for update;

  -- REGRA DO VINCULO (18/09/2026), por mensalidade:
  --   1. sem vinculo ativo ............ cria o vinculo ativo com este acordo;
  --   2. so vinculo INATIVO antigo .... o historico fica como esta e nasce um
  --                                     vinculo ativo novo;
  --   3. ativo com ESTE acordo ........ trabalho ja feito: nada e duplicado;
  --   4. ativo com OUTRO acordo ....... a operacao inteira volta sem escrever
  --                                     nada: nao move, nao desativa;
  --   5. nunca dois vinculos ativos para a mesma mensalidade (o indice unico
  --      ux_titulo_vinculo_ativo continua de guarda).
  -- Antes, a linha do vinculo so era criada quando a mensalidade nao tinha
  -- NENHUMA linha na tabela -- uma linha inativa de acordo antigo bastava para
  -- a mensalidade sair PAGO sem amarra, e a funcao respondia "ok".

  -- id que nao existe e erro dito, nao item ignorado em silencio
  select array_agg(x) into v_faltando
    from unnest(p_titulo_ids) x
   where not exists (select 1 from public.acordos_titulos t where t.id = x);
  if v_faltando is not null then
    return jsonb_build_object('ok', false, 'erro', 'TITULO_NAO_ENCONTRADO', 'titulos', to_jsonb(v_faltando));
  end if;

  -- regra 4: vinculo ativo com outro acordo -- nada foi escrito ainda
  select jsonb_agg(jsonb_build_object('titulo_id', v.titulo_id, 'acordo_id', v.acordo_id))
    into v_conflitos
    from public.acordo_titulo_vinculo v
   where v.titulo_id = any(p_titulo_ids)
     and v.acordo_id <> p_acordo_id
     and coalesce(v.ativo, true);
  if v_conflitos is not null then
    return jsonb_build_object('ok', false, 'erro', 'TITULO_COM_VINCULO_ATIVO_EM_OUTRO_ACORDO',
                              'conflitos', v_conflitos);
  end if;

  -- regra 3: ja esta neste acordo -- e so conta quando a LINHA do vinculo
  -- ativo existe. `acordo_id` preenchido sem a linha e amarra faltando (regra
  -- 1), nao trabalho feito.
  -- `coalesce` obrigatorio: comparacao com NULL da NULL, e `not NULL` sumiria
  -- com a linha das duas listas.
  select count(*) into v_ja
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and coalesce(
          t.aluno_id = v_aluno_acordo
          and exists (select 1 from public.acordo_titulo_vinculo v
                       where v.titulo_id = t.id and v.acordo_id = p_acordo_id
                         and coalesce(v.ativo,true))
        , false);

  -- regra 1, amarra faltando: a mensalidade ja aponta para este acordo e do
  -- mesmo aluno, mas nao tem a linha do vinculo. So a linha nasce; situacao e
  -- status ficam como estao.
  select array_agg(t.id) into v_reparo
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and coalesce(t.aluno_id = v_aluno_acordo and t.acordo_id = p_acordo_id, false)
    and not exists (select 1 from public.acordo_titulo_vinculo v
                     where v.titulo_id = t.id and coalesce(v.ativo,true));

  select array_agg(t.id) into v_novos
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and not coalesce(
          t.aluno_id = v_aluno_acordo
          and (coalesce(t.acordo_id = p_acordo_id, false)
               or exists (select 1 from public.acordo_titulo_vinculo v
                           where v.titulo_id = t.id and v.acordo_id = p_acordo_id
                             and coalesce(v.ativo,true)))
        , false);

  if (v_novos is null or array_length(v_novos,1) is null)
     and (v_reparo is null or array_length(v_reparo,1) is null) then
    -- tudo que veio ja estava vinculado a este acordo, com a linha ativa
    return jsonb_build_object('ok', true, 'vinculados', 0, 'ja_estavam', v_ja,
                              'acordo_id', p_acordo_id, 'status_acordo', v_status_acordo);
  end if;

  -- mesmo cuidado com NULL aqui: titulo sem aluno_id daria NULL e escaparia da
  -- lista de bloqueados em vez de ser barrado.
  select array_agg(t.id) into v_bloqueados
  from public.acordos_titulos t
  where t.id = any(coalesce(v_novos, '{}'::uuid[]))
    and not coalesce(
          (
            t.aluno_id = v_aluno_acordo
            and t.acordo_id is null
            and lower(coalesce(t.status,'')) not in
                  ('vinculada','quitada','quitado','paga','pago','cancelada','cancelado')
            and upper(coalesce(t.situacao,'')) <> 'DUPLICADA'
            and (
                  coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0) > 0
              or upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
            )
          )
          or
          (
            -- RE-ACORDO (22/09/2026): mensalidade NEGOCIADA cujo acordo
            -- anterior foi cancelado, com saldo residual deterministico e
            -- auditavel (ver acordo_saldo_residual). O vinculo antigo (linha
            -- ja INATIVA) nao e tocado aqui -- so passa a barreira; quem cria
            -- o vinculo ativo novo e o bloco de insercao mais abaixo, que ja
            -- existia.
            t.aluno_id = v_aluno_acordo
            and upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
            and lower(coalesce(t.status,'')) = 'vinculada'
            and t.acordo_id is not null
            and t.acordo_id <> p_acordo_id
            and exists (
              select 1 from public.acordos ax
               where ax.id = t.acordo_id
                 and upper(coalesce(ax.status,'')) in ('CANCELADO','CANCELADA')
            )
            and coalesce((public.acordo_saldo_residual(t.acordo_id)->>'confiavel')::boolean, false)
          )
        , false);

  if v_bloqueados is not null and array_length(v_bloqueados,1) > 0 then
    return jsonb_build_object('ok',false,'erro','PARCELAS_INELEGIVEIS',
                              'bloqueados', to_jsonb(v_bloqueados), 'ja_estavam', v_ja);
  end if;

  -- RE-ACORDO E TUDO-OU-NADA (22/09/2026).
  --
  -- A cadeia de origem e lida em `acordo_titulo_vinculo`, INCLUSIVE nas linhas
  -- ja INATIVAS que a 20260922265000 passou a preservar -- nunca so por
  -- `acordos_titulos.acordo_id`, que e um ponteiro unico e some assim que a
  -- mensalidade entra no acordo novo. O vinculo e a unica fonte que guarda a
  -- composicao completa do acordo anterior depois do cancelamento.
  --
  -- QUEM CONTA COMO "titulo de A" e, exatamente, quem AINDA esta preso a A:
  -- situacao NEGOCIADO e acordo_id = A. E a mesma condicao do ramo de re-acordo
  -- na elegibilidade, de proposito -- a trava so pode alcancar o que a
  -- elegibilidade deixou passar por aquele ramo.
  --
  -- Isso importa por causa do legado: ate a 20260922265000 o cancelamento
  -- reabria a mensalidade pra ABERTO e ela continuava com a LINHA de vinculo
  -- apontando pro acordo cancelado. Um titulo assim hoje e mensalidade comum,
  -- com valor proprio em aberto -- nao carrega residual de acordo nenhum. Se a
  -- trava olhasse so pra existencia da linha de vinculo, renegociar UMA dessas
  -- mensalidades passaria a exigir todas as irmas do acordo cancelado antigo --
  -- uma restricao nova sobre operacao corriqueira, que nada tem a ver com o
  -- risco que se quer cobrir. Sao os 10 acordos multi-titulo legados medidos em
  -- producao, cujos titulos estao todos ABERTO.
  --
  -- Tambem ficam de fora, pelo mesmo teste: titulo em estado terminal
  -- (PAGO/quitada/CANCELADA), que nao pode entrar em acordo nenhum e travaria
  -- para sempre um re-acordo legitimo; e titulo ja com vinculo ATIVO em um
  -- TERCEIRO acordo, que saiu da cadeia de A por decisao anterior (a regra 4,
  -- mais acima, ja barra quem tentar move-lo a forca).
  --
  -- Titulo EXTRA, que nunca pertenceu a A, e permitido de proposito: montar um
  -- acordo novo juntando a divida residual com mensalidade nova e operacao
  -- legitima e corriqueira. Ele nao contamina a cadeia historica porque o
  -- vinculo nasce apontando pra B; nenhuma linha e criada ligando esse titulo a
  -- A -- so a exigencia acima olha pra A.
  select jsonb_agg(jsonb_build_object(
           'acordo_anterior_id', o.acordo_anterior,
           'titulos_faltando', o.faltando))
    into v_reacordo_parcial
    from (
      select ax.id as acordo_anterior, jsonb_agg(distinct v2.titulo_id) as faltando
        from public.acordos ax
        join public.acordo_titulo_vinculo v2 on v2.acordo_id = ax.id
        join public.acordos_titulos t2 on t2.id = v2.titulo_id
       where upper(coalesce(ax.status,'')) in ('CANCELADO','CANCELADA')
         and ax.id <> p_acordo_id
         -- A e a origem de pelo menos uma mensalidade que esta ENTRANDO agora
         -- PELO RAMO DE RE-ACORDO (ainda NEGOCIADA e presa a A) -- nao basta
         -- existir uma linha de vinculo antiga
         and exists (
           select 1 from public.acordo_titulo_vinculo v1
             join public.acordos_titulos t1 on t1.id = v1.titulo_id
            where v1.acordo_id = ax.id
              and v1.titulo_id = any(coalesce(v_novos, '{}'::uuid[]))
              and upper(coalesce(t1.situacao,'')) = 'NEGOCIADO'
              and t1.acordo_id = ax.id)
         -- ...e este titulo, tambem ainda preso a A, ficou de fora do pedido
         and not (v2.titulo_id = any(p_titulo_ids))
         and upper(coalesce(t2.situacao,'')) = 'NEGOCIADO'
         and t2.acordo_id = ax.id
         and not exists (
           select 1 from public.acordo_titulo_vinculo v3
            where v3.titulo_id = v2.titulo_id
              and coalesce(v3.ativo, true)
              and v3.acordo_id <> p_acordo_id)
       group by ax.id
    ) o;

  if v_reacordo_parcial is not null then
    return jsonb_build_object('ok', false, 'erro', 'REACORDO_PARCIAL',
      'detalhe', 'o acordo anterior tem mensalidade que ficou fora do pedido -- '
                 || 'o re-acordo tem de levar a cadeia inteira, senao sobra divida '
                 || 'orfa do mesmo saldo residual',
      'pendencias', v_reacordo_parcial, 'ja_estavam', v_ja);
  end if;

  -- O estado da mensalidade segue o acordo (20260902140000): acordo pago deixa
  -- a mensalidade quitada; acordo ativo deixa negociada.
  v_quitado := v_status_acordo = 'QUITADO'
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = p_acordo_id
         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA'));

  if v_novos is not null then
    if v_quitado then
      update public.acordos_titulos t
         set acordo_id = p_acordo_id, situacao = 'PAGO', status = 'quitada',
             motivo_ajuste = coalesce(t.motivo_ajuste,'')
               || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
               || 'quitada junto com o acordo ' || v_numero
               || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
             vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
       where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;
    else
      update public.acordos_titulos t
         set acordo_id = p_acordo_id, situacao = 'NEGOCIADO', status = 'vinculada',
             vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
       where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;
    end if;
    get diagnostics v_n = row_count;
  end if;

  -- A LINHA DO VINCULO: para toda mensalidade nova ou com amarra faltando que
  -- nao tenha vinculo ATIVO. Linha inativa antiga nao impede mais -- ela e
  -- historico e fica intocada.
  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)
  select p_acordo_id, t.id, true, v_email, now()
  from public.acordos_titulos t
  where t.id = any(coalesce(v_novos, '{}'::uuid[]) || coalesce(v_reparo, '{}'::uuid[]))
    and t.aluno_id = v_aluno_acordo
    and not exists (select 1 from public.acordo_titulo_vinculo v
                     where v.titulo_id = t.id and coalesce(v.ativo,true));
  get diagnostics v_criados = row_count;

  -- A PROVA: toda mensalidade pedida sai com exatamente UM vinculo ativo, e com
  -- este acordo. Se nao, a transacao inteira volta -- a mensalidade nao fica
  -- NEGOCIADO/PAGO sem amarra.
  select count(*) into v_sem_amarra
    from unnest(p_titulo_ids) x
   where (select count(*) from public.acordo_titulo_vinculo v
           where v.titulo_id = x and v.acordo_id = p_acordo_id
             and coalesce(v.ativo, true)) <> 1;
  if v_sem_amarra > 0 then
    raise exception 'VINCULO_INCOMPLETO: % mensalidade(s) sem exatamente um vinculo ativo com o acordo %',
      v_sem_amarra, p_acordo_id;
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'VINCULOU_TITULOS_ACORDO', 'acordos_titulos', p_acordo_id,
          jsonb_build_object('acordo_id', p_acordo_id, 'qtd', v_n, 'ja_estavam', v_ja,
                             'amarras_refeitas', coalesce(cardinality(v_reparo), 0),
                             'vinculos_criados', v_criados,
                             'status_acordo', v_status_acordo,
                             'estado_titulo', case when v_quitado then 'quitada' else 'vinculada' end,
                             'titulo_ids', p_titulo_ids));

  return jsonb_build_object('ok', true, 'vinculados', v_n + coalesce(cardinality(v_reparo), 0),
                            'ja_estavam', v_ja,
                            'amarras_refeitas', coalesce(cardinality(v_reparo), 0),
                            'vinculos_criados', v_criados,
                            'acordo_id', p_acordo_id, 'status_acordo', v_status_acordo,
                            'estado_titulo', case when v_quitado then 'quitada' else 'vinculada' end);
end;
$function$;
