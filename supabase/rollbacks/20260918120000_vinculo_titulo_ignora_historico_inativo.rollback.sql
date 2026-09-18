-- ROLLBACK de 20260918120000_vinculo_titulo_ignora_historico_inativo.sql
--
-- Devolve os dois corpos exatos de producao de 18/09/2026 (md5 conferido no
-- banco: vincular_titulos_acordo bfad7027, acordo_avista_registrar 391bbee9),
-- que sao os de 20260917230000_recuperar_acordo_avista_automatico.sql. Nao
-- mexe em dado: vinculo criado enquanto a regra nova valeu continua valendo.

create or replace function public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '60s'
as $fn$
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

  -- Ja esta neste mesmo acordo: nao e erro, e trabalho ja feito.
  -- `coalesce` obrigatorio: em titulo sem acordo, `t.acordo_id = p_acordo_id` da
  -- NULL (nao `false`), e `not NULL` e NULL -- a linha sumia da lista de novos e
  -- a funcao respondia "0 vinculados" sem vincular nada. Pego no teste.
  select count(*) into v_ja
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and coalesce(
          t.aluno_id = v_aluno_acordo
          and (coalesce(t.acordo_id = p_acordo_id, false)
               or exists (select 1 from public.acordo_titulo_vinculo v
                           where v.titulo_id = t.id and v.acordo_id = p_acordo_id
                             and coalesce(v.ativo,true)))
        , false);

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

  if v_novos is null or array_length(v_novos,1) is null then
    -- tudo que veio ja estava vinculado a este acordo
    return jsonb_build_object('ok', true, 'vinculados', 0, 'ja_estavam', v_ja,
                              'acordo_id', p_acordo_id, 'status_acordo', v_status_acordo);
  end if;

  -- mesmo cuidado com NULL aqui: titulo sem aluno_id daria NULL e escaparia da
  -- lista de bloqueados em vez de ser barrado.
  select array_agg(t.id) into v_bloqueados
  from public.acordos_titulos t
  where t.id = any(v_novos)
    and not coalesce(
          t.aluno_id = v_aluno_acordo
      and t.acordo_id is null
      and lower(coalesce(t.status,'')) not in
            ('vinculada','quitada','quitado','paga','pago','cancelada','cancelado')
      and upper(coalesce(t.situacao,'')) <> 'DUPLICADA'
      and (
            coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0) > 0
        or upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
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

  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)
  select p_acordo_id, t.id, true, v_email, now()
  from public.acordos_titulos t
  where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo
    and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'VINCULOU_TITULOS_ACORDO', 'acordos_titulos', p_acordo_id,
          jsonb_build_object('acordo_id', p_acordo_id, 'qtd', v_n, 'ja_estavam', v_ja,
                             'status_acordo', v_status_acordo,
                             'estado_titulo', case when v_quitado then 'quitada' else 'vinculada' end,
                             'titulo_ids', p_titulo_ids));

  return jsonb_build_object('ok', true, 'vinculados', v_n, 'ja_estavam', v_ja,
                            'acordo_id', p_acordo_id, 'status_acordo', v_status_acordo,
                            'estado_titulo', case when v_quitado then 'quitada' else 'vinculada' end);
end;
$fn$;

create or replace function public.acordo_avista_registrar(
  p_pagamento_id uuid, p_titulo_ids uuid[] default null, p_confirmar boolean default false
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '60s'
as $fn$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_titulos uuid[];
  v_previa jsonb;
  v_aluno uuid;
  v_acordo_id uuid;
  v_parcela_id uuid;
  v_vinculo jsonb;
  v_pagamento jsonb;
  v_marca text;
  v_depois jsonb;
begin
  -- Portao interno. EXECUTE continua com authenticated: revogar derrubaria a
  -- tela para a propria gestao.
  -- A PORTA DA GESTAO CONTINUA A MESMA. A etapa automatica entra pela segunda
  -- condicao -- `acordo_avista_porta_interna()` --, que exige a chave
  -- transacional E a pilha de chamada da rotina: de fora nao ha como produzir
  -- as duas.
  if not coalesce(public.usuario_e_gestao(), false)
     and not public.acordo_avista_porta_interna() then
    raise exception 'Registrar acordo à vista é decisão da gestão financeira.' using errcode = '42501';
  end if;
  -- sem JWT (rodada horaria ou importacao) o registro assina como sistema
  if v_email = '' then v_email := 'conciliacao@sistema'; end if;

  select array_agg(distinct x) into v_titulos
    from unnest(p_titulo_ids) x where x is not null;
  -- Lista vazia e escolha ("nenhuma"), nao pedido de sugestao: so NULL sugere.
  if p_titulo_ids is not null and v_titulos is null then
    v_titulos := '{}'::uuid[];
  end if;

  if not coalesce(p_confirmar, false) then
    return public.acordo_avista_previa(p_pagamento_id, v_titulos)
           || jsonb_build_object('ok', true, 'modo', 'SIMULACAO', 'gravou', false);
  end if;

  -- Confirmar nunca usa a sugestao: a lista de mensalidades tem de vir escolhida.
  if v_titulos is null or cardinality(v_titulos) = 0 then
    return jsonb_build_object('ok', false, 'modo', 'RECUSADO', 'gravou', false,
                              'bloqueios', jsonb_build_array('TITULOS_ESCOLHIDOS'),
                              'motivo', 'confirmar exige as mensalidades escolhidas pela gestão');
  end if;

  -- Dois cliques simultaneos no mesmo pagamento: o segundo espera e, ao reler,
  -- encontra o acordo ja criado e e recusado pela previa.
  perform pg_advisory_xact_lock(hashtextextended('acordo_avista:' || p_pagamento_id::text, 0));

  v_previa := public.acordo_avista_previa(p_pagamento_id, v_titulos);

  if not coalesce((v_previa ->> 'aprovado')::boolean, false) then
    return v_previa || jsonb_build_object('ok', false, 'modo', 'RECUSADO', 'gravou', false);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('acordo_ulbra:' || (v_previa -> 'acordo_a_criar' ->> 'numero_ulbra'), 0));

  v_aluno := (v_previa -> 'aluno' ->> 'id')::uuid;
  v_marca := 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO | pagamento ' || p_pagamento_id::text
          || ' | boleto ' || (v_previa -> 'parcela_a_criar' ->> 'boleto')
          || ' | confirmado por ' || v_email
          || ' em ' || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI');

  -- O ACORDO. Responsavel = operador do pagamento, preenchido na insercao para
  -- que `_acordo_herda_responsavel_do_aluno` nao o troque pelo dono do aluno.
  insert into public.acordos
    (aluno_id, cpf, tipo, forma_pagamento, valor_total, qtd_parcelas, status, unidade, saldo,
     observacao, criado_por_email, criado_por_nome, numero_ulbra,
     operador_responsavel_email, operador_responsavel_nome, criado_em, atualizado_em)
  select a.id, a.cpf, 'ACORDO', 'PARCELADO',
         (v_previa -> 'acordo_a_criar' ->> 'valor_total')::numeric, 1, 'ATIVO', a.unidade,
         (v_previa -> 'acordo_a_criar' ->> 'valor_total')::numeric,
         v_marca, v_email, 'Recuperação de acordo pago sem importação',
         v_previa -> 'acordo_a_criar' ->> 'numero_ulbra',
         v_previa -> 'acordo_a_criar' ->> 'operador_responsavel_email',
         v_previa -> 'acordo_a_criar' ->> 'operador_responsavel_nome',
         now(), now()
    from public.alunos a
   where a.id = v_aluno
  returning id into v_acordo_id;

  if v_acordo_id is null then
    raise exception 'RECUPERACAO_ABORTADA: o aluno % sumiu entre a previa e a gravacao', v_aluno;
  end if;

  -- A PARCELA, com o boleto do proprio pagamento. `boleto_confiavel` e
  -- verdadeiro porque o numero nao foi inferido: veio impresso no boleto pago.
  insert into public.parcelas
    (acordo_id, numero, valor, vencimento, status, is_entrada, boleto, boleto_confiavel,
     observacao, criado_em, atualizado_em)
  values (v_acordo_id, 1,
          (v_previa -> 'parcela_a_criar' ->> 'valor')::numeric,
          (v_previa -> 'parcela_a_criar' ->> 'vencimento')::date,
          v_previa -> 'parcela_a_criar' ->> 'status',
          false,
          v_previa -> 'parcela_a_criar' ->> 'boleto',
          true, v_marca, now(), now())
  returning id into v_parcela_id;

  -- AS MENSALIDADES, pela funcao que ja existe (as quatro coisas do vinculo).
  v_vinculo := public.vincular_titulos_acordo(v_titulos, v_acordo_id);
  if not coalesce((v_vinculo ->> 'ok')::boolean, false)
     or coalesce((v_vinculo ->> 'vinculados')::int, -1) <> cardinality(v_titulos) then
    raise exception 'RECUPERACAO_ABORTADA: o vínculo das mensalidades não saiu como simulado (%)', v_vinculo::text;
  end if;

  -- O PAGAMENTO, pela funcao que ja existe: grava o aluno e chama o motor, que
  -- encontra a parcela pelo boleto e baixa.
  v_pagamento := public.pagamento_vincular_aluno(p_pagamento_id, v_aluno, v_marca);
  if coalesce(v_pagamento -> 'conciliacao' ->> 'status', '') <> 'BAIXADO' then
    raise exception 'RECUPERACAO_ABORTADA: o motor não baixou a parcela criada (%)', coalesce(v_pagamento::text, 'null');
  end if;

  -- O ESTADO FINAL TEM DE SER O SIMULADO. Qualquer desvio desfaz tudo.
  if not exists (select 1 from public.parcelas
                  where id = v_parcela_id and upper(coalesce(status, '')) = 'PAGO'
                    and origem_baixa_ref = p_pagamento_id::text)
     or not exists (select 1 from public.acordos
                     where id = v_acordo_id and upper(coalesce(status, '')) = 'QUITADO'
                       and lower(coalesce(operador_responsavel_email, ''))
                           = lower(coalesce(v_previa -> 'acordo_a_criar' ->> 'operador_responsavel_email', '')))
     or exists (select 1 from public.acordos_titulos
                 where id = any(v_titulos) and upper(coalesce(situacao, '')) <> 'PAGO') then
    raise exception 'RECUPERACAO_ABORTADA: o estado final difere do simulado para o pagamento %', p_pagamento_id;
  end if;

  select jsonb_build_object(
    'pagamento', (select jsonb_build_object('status_conciliacao', p.status_conciliacao, 'aluno_id', p.aluno_id,
                                            'origem_vinculo', p.origem_vinculo)
                    from public.pagamentos p where p.id = p_pagamento_id),
    'fila', (select jsonb_build_object('decisao', f.decisao, 'decidido_por', f.decidido_por)
               from public.fila_pagamento_sem_vinculo f where f.pagamento_id = p_pagamento_id),
    'acordo', (select jsonb_build_object('id', a.id, 'numero_ulbra', a.numero_ulbra, 'status', a.status,
                                         'operador_responsavel_email', a.operador_responsavel_email)
                 from public.acordos a where a.id = v_acordo_id),
    'parcela', (select jsonb_build_object('id', q.id, 'status', q.status, 'boleto', q.boleto,
                                          'confirmado_por_email', q.confirmado_por_email, 'origem_baixa', q.origem_baixa)
                  from public.parcelas q where q.id = v_parcela_id),
    'titulos', (select jsonb_agg(jsonb_build_object('id', t.id, 'documento', t.documento,
                                                    'situacao', t.situacao, 'status', t.status))
                  from public.acordos_titulos t where t.id = any(v_titulos)),
    'aluno', (select jsonb_build_object('saldo_total', a.saldo_total, 'situacao_operacional', a.situacao_operacional,
                                        'status_atual', a.status_atual,
                                        'responsavel_atual_email', a.responsavel_atual_email)
                from public.alunos a where a.id = v_aluno),
    'confirmacoes_pendentes', (select count(*) from public.solicitacoes_confirmacao_pagamento s
                                where s.aluno_id = v_aluno::text and s.status = 'AGUARDANDO_CONFIRMACAO'))
  into v_depois;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO', 'acordos', v_acordo_id,
          jsonb_build_object(
            'origem', 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO',
            'confirmado_por', v_email,
            'confirmado_em', now(),
            'pagamento_id', p_pagamento_id,
            'acordo_id', v_acordo_id,
            'numero_ulbra', v_previa -> 'acordo_a_criar' ->> 'numero_ulbra',
            'parcela_id', v_parcela_id,
            'titulo_ids', to_jsonb(v_titulos),
            'operador_original', v_previa -> 'credito',
            'estado_antes', v_previa,
            'estado_depois', v_depois));

  return v_previa || jsonb_build_object(
    'ok', true, 'modo', 'CONFIRMADO', 'gravou', true,
    'acordo_id', v_acordo_id, 'parcela_id', v_parcela_id,
    'estado_depois', v_depois);
end;
$fn$;
