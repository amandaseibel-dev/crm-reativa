-- ROLLBACK de 20260922270000_reacordo_saldo_residual_deterministico.sql
--
-- ROLLBACK DE CODIGO E COMPORTAMENTO. NAO E ROLLBACK DE DADOS.
--
-- Duas acoes, e so estas:
--
--   1. `public.acordo_saldo_residual(uuid)` e FUNCAO NOVA -- nao existia em
--      producao antes de 22/09/2026 (conferido: nenhuma outra migration ou
--      ledger do repositorio a define). O rollback a remove.
--   2. `public.vincular_titulos_acordo(uuid[], uuid)` volta ao corpo VIGENTE
--      antes desta migration: o do ledger
--      20260918121835__vinculo_titulo_ignora_historico_inativo.sql -- que e a
--      versao de MAIOR timestamp, ou seja, a que de fato rodou em producao.
--      O par executavel (migration 20260918120000) tem o mesmo conteudo; a
--      copia abaixo saiu do ledger por ser a trilha do que rodou.
--
-- O QUE ESTE ROLLBACK NAO FAZ, POR DECISAO EXPLICITA DA GESTAO (22/09/2026):
--
--   * NAO faz saneamento nem reversao massiva de dados;
--   * NAO apaga historico criado enquanto a migration esteve ativa;
--   * NAO reabre nem renegocia titulo em lote;
--   * NAO desfaz pagamento nenhum;
--   * NAO altera acordo existente por inferencia;
--   * NAO desfaz re-acordo que tenha sido criado enquanto a regra esteve
--     ativa -- acordo e parcela nao tem DELETE neste sistema, e desfazer um
--     re-acordo por rollback de codigo seria decidir por inferencia.
--
-- CONSEQUENCIA ASSUMIDA: sem `acordo_saldo_residual`, a tela perde o calculo
-- do residual e volta a nao oferecer re-acordo seguro. Os re-acordos ja
-- criados permanecem validos e consultaveis.
--
-- ORDEM: a funcao nova sai DEPOIS que `vincular_titulos_acordo` volta ao corpo
-- antigo -- o corpo antigo nao a referencia, entao a remocao nao quebra nada.

-- ---------------------------------------------------------------------------
-- 1 de 2. vincular_titulos_acordo volta ao corpo vigente de 18/09/2026
-- ---------------------------------------------------------------------------

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
$fn$;

-- ---------------------------------------------------------------------------
-- 2 de 2. acordo_saldo_residual era nova -- sai
-- ---------------------------------------------------------------------------

drop function if exists public.acordo_saldo_residual(uuid);

-- ---------------------------------------------------------------------------
-- PROVA DO ROLLBACK
-- ---------------------------------------------------------------------------

do $prova$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='acordo_saldo_residual') then
    raise exception 'acordo_saldo_residual continua no banco';
  end if;

  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='vincular_titulos_acordo') then
    raise exception 'vincular_titulos_acordo sumiu';
  end if;

  -- o corpo restaurado NAO pode mais mencionar a funcao removida: se
  -- mencionasse, a RPC quebraria em tempo de execucao
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='vincular_titulos_acordo')
     ilike '%acordo_saldo_residual%' then
    raise exception 'vincular_titulos_acordo restaurada ainda chama acordo_saldo_residual';
  end if;
end $prova$;
