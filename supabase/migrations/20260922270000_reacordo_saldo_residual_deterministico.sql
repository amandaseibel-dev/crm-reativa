-- RE-ACORDO: MENSALIDADE NEGOCIADA CUJO ACORDO FOI CANCELADO VOLTA A SER
-- RENEGOCIAVEL, PELO SALDO RESIDUAL DETERMINISTICO -- NUNCA POR APROXIMACAO.
--
-- CONTINUACAO de 20260922260000 (mensalidade nao reabre mais pra ABERTO
-- quando o acordo cancela). Essa correcao criou um problema novo, achado na
-- auditoria: a mensalidade fica presa. `vincular_titulos_acordo` (a RPC que
-- monta acordo novo, chamada tanto da tela de "montar acordo" quanto de
-- VincularMensalidadesAcordo.jsx) so aceita titulo com `acordo_id is null` --
-- e a mensalidade preservada tem `acordo_id` apontando pro acordo cancelado.
-- Sem este ajuste, a divida fica correta no saldo agregado (nao desaparece,
-- ver 20260922260000) mas NINGUEM consegue renegocia-la pela tela.
--
-- ESTRUTURA JA EXISTIA, NAO PRECISOU MUDAR: acordo_titulo_vinculo tem indice
-- unico PARCIAL `ux_titulo_vinculo_ativo (titulo_id) WHERE ativo` -- no
-- maximo um vinculo ATIVO por titulo, mas vinculos INATIVOS historicos sao
-- ilimitados. A cadeia mensalidade -> acordo1 (CANCELADO, vinculo inativo)
-- -> acordo2 (vinculo ativo novo) ja e representavel. Nao ha ALTER TABLE
-- nesta migration.
--
-- O SALDO RESIDUAL NAO E `valor_total` NEM `valor_em_aberto` DA MENSALIDADE
-- (medido em producao, 22/09/2026, 510 acordos CANCELADO com parcela):
--   - `acordos.saldo` NAO E CONFIAVEL: em acordos ATIVO so bate com
--     soma(parcelas abertas) em 89,7% dos casos e diverge de QUALQUER formula
--     simples em 9,9% -- nao pode ser fonte de verdade.
--   - a formula certa, validada por reconciliacao (nao por definicao): um
--     acordo cancelado "reconcilia" quando
--       SUM(parcelas.valor WHERE status='PAGO') + SUM(parcelas.valor WHERE status='CANCELADA')
--       ~= acordos.valor_total (diferenca < 1 centavo)
--     Quando reconcilia, o residual = SUM(parcelas.valor WHERE status='CANCELADA')
--     -- e bate exatamente com o exemplo da Amanda: mensalidade R$1.000,
--     2 parcelas de R$500, uma paga, uma cancelada -> pago+cancelado=1.000=
--     valor_total (reconcilia) -> residual=R$500, nao R$1.000.
--   - 487 de 510 (95,5%, R$ 2.237.296,14) reconciliam limpo.
--   - 23 NAO reconciliam (R$ 73.710,73) e ficam de fora da elegibilidade
--     automatica, em duas causas distintas (a Amanda pediu para separar,
--     provavelmente exigem correcao diferente cada uma):
--       * RESIDUAL_DIVERGENCIA_ESTRUTURAL (19, R$ 54.933,97): 6 acordos
--         cancelados sem NENHUMA parcela + 13 sem nenhum pagamento onde
--         mesmo assim as parcelas CANCELADA nao somam o valor_total (parcela
--         faltando, duplicada ou valor_total editado depois da criacao).
--       * RESIDUAL_PAGAMENTO_FORA_DA_ESTRUTURA (4, R$ 18.776,76): existe
--         pagamento registrado, mas pago+cancelado nao bate com valor_total
--         (ex.: acordo 1461 -- 3 parcelas extras numero=0 pagas a parte,
--         fora da sequencia normal 1..N, enquanto as parcelas 1..N sozinhas
--         ja fecham o valor_total sem contar esse pagamento).
--   - honorarios (coluna separada em `parcelas`, nao somada em `valor`) NAO
--     entram no residual: nenhum lugar do sistema hoje (titulo_reavaliar,
--     aluno_saldo_pendente_detalhe) conta honorario como divida -- so entram
--     quando um acordo NOVO e negociado.
--
-- TERCEIRO MOTIVO, achado durante a implementacao (a Amanda pediu 2 causas
-- pros 23; este e ortogonal, product de um acordo RECONCILIADO que mesmo
-- assim nao pode dar residual pra UMA mensalidade so): um acordo cancelado
-- pode ter tido MAIS DE UMA mensalidade original negociada nele. Repartir o
-- residual entre elas seria rateio por aproximacao -- exatamente o que foi
-- proibido. Dos 487 reconciliados, 10 tem mais de um titulo no vinculo
-- historico (23 tem exatamente 1; 454 nao tem NENHUMA linha de vinculo --
-- efeito do `cancelar_acordo_ficha` antigo, que ATE 20260922260000 apagava o
-- vinculo por DELETE; esses 454 nao tem titulo NEGOCIADO ao vivo apontando
-- pra eles hoje -- 0 casos, medido -- entao essa lacuna historica nao afeta
-- elegibilidade nenhuma agora, so nao pode ser usada como prova de
-- "titulo unico" no futuro). Dai a exigencia de EXATAMENTE 1 titulo no
-- vinculo: motivo RESIDUAL_MULTIPLOS_TITULOS.
--
-- O QUE ESTA MIGRATION NAO FAZ: nao sanea nenhum dos 295 titulos historicos
-- (133 ABERTO / 72 pagos / 81 renegociados / 9 EM_CONFIRMACAO ficam
-- intocados), nao mexe nas 6 parcelas VENCIDA presas em acordo CANCELADO
-- (registrado como inconsistencia separada, nao corrigida aqui), nao
-- sobrescreve valor_em_aberto/saldo_corrigido/valor_original da mensalidade
-- em nenhum caminho, nao cria ACORDO ANULADO (so deixa o design compativel:
-- a guarda de titulo_reavaliar em 20260922260000 bloqueia especificamente
-- CANCELADO/CANCELADA/QUEBRADO/INATIVO -- nao inclui ANULADO de proposito,
-- entao uma futura RPC dedicada de anulacao ja herdaria o comportamento
-- antigo de reabertura sem precisar mexer aqui de novo).

-- ---------------------------------------------------------------------------
-- 1) acordo_saldo_residual: fonte unica de verdade do residual. Le so
--    parcelas e valor_total; nunca escreve nada.
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

  if v_titulos <> 1 then
    return jsonb_build_object('confiavel', false, 'residual', round(v_cancelado, 2),
      'motivo', 'RESIDUAL_MULTIPLOS_TITULOS',
      'detalhe', 'acordo tem ' || v_titulos || ' mensalidade(s) no historico de vinculo -- '
                 || 'repartir o residual entre elas seria rateio por aproximacao');
  end if;

  if round(v_cancelado, 2) <= 0 then
    return jsonb_build_object('confiavel', false, 'residual', 0,
      'motivo', 'RESIDUAL_ZERO',
      'detalhe', 'nao ha saldo residual: nada a renegociar');
  end if;

  return jsonb_build_object('confiavel', true, 'residual', round(v_cancelado, 2), 'motivo', null);
end;
$function$;

comment on function public.acordo_saldo_residual(uuid) is
  'Saldo residual deterministico de um acordo CANCELADO: SUM(parcelas CANCELADA), so quando pago+cancelado reconcilia com valor_total e ha exatamente 1 mensalidade no historico de vinculo. confiavel=false com motivo RESIDUAL_DIVERGENCIA_ESTRUTURAL / RESIDUAL_PAGAMENTO_FORA_DA_ESTRUTURA / RESIDUAL_MULTIPLOS_TITULOS / RESIDUAL_ZERO caso contrario -- nunca aproxima.';

grant execute on function public.acordo_saldo_residual(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) vincular_titulos_acordo: unico ponto alterado e a regra de elegibilidade
--    (v_bloqueados). Passa a aceitar TAMBEM titulo NEGOCIADO cujo acordo_id
--    aponta pra um acordo CANCELADO/CANCELADA com saldo residual confiavel.
--    O resto da funcao (regras 1-5 do comentario original) ja fazia a coisa
--    certa: titulo com vinculo INATIVO antigo ganha vinculo ATIVO novo sem
--    tocar no historico -- so nunca chegava la porque a elegibilidade barrava
--    antes. Nada mais mudou: mesmo corpo, byte a byte, fora deste bloco.
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
