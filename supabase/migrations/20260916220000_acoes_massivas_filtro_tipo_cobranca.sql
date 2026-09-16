-- Acoes Massivas: filtro "Tipo de cobranca".
--
-- Amanda, 16/09/2026. Regra final, sem ambiguidade:
--   MENSALIDADES            "Somente mensalidades": alunos elegiveis com
--                           mensalidade original em aberto.
--   ACORDOS_VENCIDOS        "Somente acordos vencidos": alunos elegiveis com
--                           acordo quebrado ou parcela vencida.
--   MENSALIDADES_E_ACORDOS  "Mensalidades e acordos": UNIAO das duas. O aluno nao
--                           precisa ter os dois tipos e nunca aparece duplicado.
-- Acordo em dia fica fora de TODAS as opcoes. Nao existe opcao "Todos": ela so
-- poderia existir se incluisse mensalidades e acordos vencidos, e isso ja e
-- "Mensalidades e acordos".
--
-- AS DEMAIS TRAVAS NAO MUDAM: quitado ou encerrado, liquidado no Prime,
-- confirmacao de pagamento, RETORNO AGENDADO (decisao expressa dela: quem tem
-- retorno futuro continua fora) e os demais bloqueios da previa.
--
-- DEFINICOES (as mesmas do saldo canonico, aluno_saldo_pendente_detalhe):
--   mensalidade original em aberto = acordos_titulos ABERTO ou NEGOCIADO, nao
--     quitado, que nao e o boleto do acordo (tipo_boleto 'Acordo'), com saldo
--     cobravel > 0 e sem vinculo ativo com acordo nao cancelado;
--   acordo vencido = acordo ATIVO com parcela VENCIDA. "Quebrado" no CRM e
--     parcela vencida ha mais tempo, entao ja esta dentro. Nao existe status
--     QUEBRADO em acordos (so ATIVO, QUITADO, CANCELADO);
--   acordo em dia = acordo ATIVO sem parcela VENCIDA. Quem tem acordo em dia sai
--     de todas as opcoes, mesmo com mensalidade em aberto -- a mesma trava de
--     hoje. Com um acordo em dia E outro vencido, conta como acordo vencido.
-- A populacao e as marcas moram em `acoes_massivas_tipo_cobranca_alunos`; o que
-- cada opcao aceita, em `acoes_massivas_tipo_cobranca_corresponde`. Previa,
-- exportacao e confirmacao usam as duas.
--
-- MEDIDO EM 16/09 (leitura, carteiras dos 8 operadores, todas as travas):
--   mensalidades 1.782 (1.501 sem acordo + 281 com acordo vencido), acordos
--   vencidos 762, total unico 2.263. A regra anterior dava 1.523: os 1.501 com
--   mensalidade mais 22 alunos SEM divida canonica (10 sem titulo, 12 so com
--   titulos pagos), que agora saem.
--
-- SEM p_tipo_cobranca (NULL ou vazio) a previa, a exportacao e a confirmacao
-- fazem exatamente o que faziam antes -- so para a tela ANTERIOR continuar
-- funcionando entre a aplicacao desta migration e a publicacao do front. A tela
-- nova sempre manda o tipo. O valor devolvido nesse caso e 'REGRA_ANTERIOR'; ele
-- nao pode ser pedido explicitamente, e 'TODOS' e recusado.
--
-- O QUE MUDA
--   * acoes_massivas_previa: `p_tipo_cobranca text default null`; devolve
--     `tipo_cobranca` e `contagem_tipo` {mensalidades, acordos_vencidos,
--     mensalidades_e_acordos_vencidos, total_unico};
--   * acoes_massivas_exportar: mesmo parametro, revalida o tipo, grava no lote;
--   * acoes_massivas_lotes: coluna `tipo_cobranca`;
--   * acoes_massivas_concluir_lote: REVALIDA o tipo do lote no banco;
--   * acoes_massivas_lotes_pendentes: mostra o tipo.
--
-- NAO MUDA: titulos, acordos, parcelas, valores e responsaveis (so leitura).
--
-- Cirurgia sobre a definicao viva, como em 20260916200000: falha alto se uma
-- ancora nao aparecer exatamente uma vez, rodar de novo e inocuo, assinatura
-- nova com ACL refeita (sem anon/PUBLIC) e antiga removida.
-- DEPENDE de 20260916200000 e 20260916210000.

do $pre$
begin
  if to_regclass('public.acoes_massivas_lotes') is null
     or to_regprocedure('public.acoes_massivas_concluir_lote(uuid,text)') is null then
    raise exception 'acoes_massivas_lotes/concluir_lote ausentes: aplique antes a migration 20260916210000';
  end if;
end $pre$;

-- 1) Populacao e marcas por aluno. Devolve so ids e booleanos.
create or replace function public.acoes_massivas_tipo_cobranca_alunos(p_aluno_ids uuid[] default null)
returns table(aluno_id uuid, tem_mensalidade boolean, tem_acordo_vencido boolean)
language sql
stable
set search_path to 'public'
as $function$
  with mens as (
    select distinct t.aluno_id
      from public.acordos_titulos t
     where (p_aluno_ids is null or t.aluno_id = any(p_aluno_ids))
       and upper(coalesce(t.situacao, '')) in ('ABERTO', 'NEGOCIADO')
       and coalesce(lower(t.status), '') <> 'quitada'
       and coalesce(t.tipo_boleto, '') <> 'Acordo'
       and coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
       and not exists (
         select 1 from public.acordo_titulo_vinculo v
           join public.acordos a on a.id = v.acordo_id
          where v.titulo_id = t.id and coalesce(v.ativo, true)
            and upper(coalesce(a.status, '')) not in ('CANCELADO', 'CANCELADA'))
  ),
  ativo as (
    select distinct a.aluno_id
      from public.acordos a
     where (p_aluno_ids is null or a.aluno_id = any(p_aluno_ids))
       and a.status = 'ATIVO'
  ),
  vencido as (
    select distinct a.aluno_id
      from public.acordos a
      join public.parcelas p on p.acordo_id = a.id
     where (p_aluno_ids is null or a.aluno_id = any(p_aluno_ids))
       and a.status = 'ATIVO'
       and p.status = 'VENCIDA'
  ),
  -- acordo vencido, ou mensalidade sem acordo em dia (acordo ativo sem vencida)
  populacao as (
    select v.aluno_id from vencido v
    union
    select m.aluno_id from mens m
     where not exists (select 1 from ativo x where x.aluno_id = m.aluno_id)
  )
  select p.aluno_id,
         exists (select 1 from mens m where m.aluno_id = p.aluno_id),
         exists (select 1 from vencido v where v.aluno_id = p.aluno_id)
    from populacao p;
$function$;

-- 2) O que cada opcao aceita. Sem opcao valida, nada.
create or replace function public.acoes_massivas_tipo_cobranca_corresponde(
  p_tipo text, p_tem_mensalidade boolean, p_tem_acordo_vencido boolean)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select case upper(coalesce(p_tipo, ''))
           when 'MENSALIDADES' then coalesce(p_tem_mensalidade, false)
           when 'ACORDOS_VENCIDOS' then coalesce(p_tem_acordo_vencido, false)
           when 'MENSALIDADES_E_ACORDOS' then coalesce(p_tem_mensalidade, false) or coalesce(p_tem_acordo_vencido, false)
           else false
         end;
$function$;

revoke all on function public.acoes_massivas_tipo_cobranca_alunos(uuid[]) from public, anon, authenticated;
grant execute on function public.acoes_massivas_tipo_cobranca_alunos(uuid[]) to service_role;
revoke all on function public.acoes_massivas_tipo_cobranca_corresponde(text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.acoes_massivas_tipo_cobranca_corresponde(text, boolean, boolean) to service_role;

-- 3) O lote guarda o tipo.
alter table public.acoes_massivas_lotes
  add column if not exists tipo_cobranca text not null default 'REGRA_ANTERIOR';
do $chk$
begin
  if not exists (select 1 from pg_constraint where conname = 'acoes_massivas_lotes_tipo_cobranca_valido') then
    alter table public.acoes_massivas_lotes
      add constraint acoes_massivas_lotes_tipo_cobranca_valido
      check (tipo_cobranca in ('REGRA_ANTERIOR', 'MENSALIDADES', 'ACORDOS_VENCIDOS', 'MENSALIDADES_E_ACORDOS'));
  end if;
end $chk$;

-- 4) Cirurgia nas quatro funcoes.
do $migration$
declare
  v_fn          text;
  v_marca       text;
  v_muda_assin  boolean;
  v_oid_antigo  oid;
  v_oid_novo    oid;
  v_def         text;
  v_qtd         int;
  v_comentario  text;
  r             record;
begin
  create temp table _trocas_tipo (fn text, ordem int, ancora text, nova text) on commit drop;

  insert into _trocas_tipo values
  -- ---------------------------------------------------------------- previa
  ('acoes_massivas_previa', 1,
$a$p_operador_email text DEFAULT NULL::text)$a$,
$a$p_operador_email text DEFAULT NULL::text, p_tipo_cobranca text DEFAULT NULL::text)$a$),
  ('acoes_massivas_previa', 2,
$a$  v_operador text := lower(nullif(btrim(p_operador_email), ''));$a$,
$a$  v_operador text := lower(nullif(btrim(p_operador_email), ''));
  -- Tipo de cobranca. Sem tipo = tela anterior (REGRA_ANTERIOR).
  v_tipo text := coalesce(upper(nullif(btrim(p_tipo_cobranca), '')), 'REGRA_ANTERIOR');$a$),
  ('acoes_massivas_previa', 3,
$a$  IF NOT v_sistema AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'Acesso negado: previa de acao massiva restrita a gestao.' USING ERRCODE = '42501';
  END IF;$a$,
$a$  IF NOT v_sistema AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'Acesso negado: previa de acao massiva restrita a gestao.' USING ERRCODE = '42501';
  END IF;
  IF nullif(btrim(p_tipo_cobranca), '') IS NOT NULL
     AND v_tipo NOT IN ('MENSALIDADES', 'ACORDOS_VENCIDOS', 'MENSALIDADES_E_ACORDOS') THEN
    RAISE EXCEPTION 'Tipo de cobranca invalido: %', p_tipo_cobranca USING ERRCODE = '22023';
  END IF;$a$),
  ('acoes_massivas_previa', 4,
$a$  liq_prime AS MATERIALIZED (
    SELECT lp.aluno_id FROM public.acoes_massivas_liquidados_prime() lp
  ),$a$,
$a$  liq_prime AS MATERIALIZED (
    SELECT lp.aluno_id FROM public.acoes_massivas_liquidados_prime() lp
  ),
  -- Populacao do tipo de cobranca (mensalidade sem acordo em dia, ou acordo
  -- vencido) com as marcas. Sem tipo nem e calculada.
  tipo_cob AS MATERIALIZED (
    SELECT tc.aluno_id, tc.tem_mensalidade, tc.tem_acordo_vencido
      FROM public.acoes_massivas_tipo_cobranca_alunos() tc
     WHERE v_tipo <> 'REGRA_ANTERIOR'
  ),$a$),
  ('acoes_massivas_previa', 5,
$a$           nullif(btrim(a.curso),'')              AS curso,
           a.unidade,$a$,
$a$           nullif(btrim(a.curso),'')              AS curso,
           a.unidade,
           coalesce(tc.tem_mensalidade, false)    AS tem_mensalidade,
           coalesce(tc.tem_acordo_vencido, false) AS tem_acordo_vencido,
           -- a opcao escolhida aceita este aluno? (sem tipo: sempre)
           (v_tipo = 'REGRA_ANTERIOR'
            OR public.acoes_massivas_tipo_cobranca_corresponde(v_tipo, tc.tem_mensalidade, tc.tem_acordo_vencido)) AS no_tipo,$a$),
  ('acoes_massivas_previa', 6,
$a$    ) c ON true$a$,
$a$    ) c ON true
    LEFT JOIN tipo_cob tc ON tc.aluno_id = a.id$a$),
  ('acoes_massivas_previa', 7,
$a$      AND NOT EXISTS (SELECT 1 FROM public.acordos ac WHERE ac.aluno_id = a.id AND ac.status = 'ATIVO')$a$,
$a$      -- Sem tipo (tela anterior): acordo ativo fica fora, como sempre.
      -- Com tipo: so a populacao de tipo_cob. Acordo em dia fica fora de todas.
      AND (v_tipo <> 'REGRA_ANTERIOR'
           OR NOT EXISTS (SELECT 1 FROM public.acordos ac WHERE ac.aluno_id = a.id AND ac.status = 'ATIVO'))
      AND (v_tipo = 'REGRA_ANTERIOR' OR tc.aluno_id IS NOT NULL)$a$),
  ('acoes_massivas_previa', 8,
$a$    SELECT * FROM filtrado
    ORDER BY data_ultimo_acionamento ASC NULLS FIRST$a$,
$a$    SELECT * FROM filtrado
    WHERE no_tipo
    ORDER BY data_ultimo_acionamento ASC NULLS FIRST$a$),
  ('acoes_massivas_previa', 9,
$a$(SELECT count(*) FROM filtrado WHERE motivo_conf IS NULL)$a$,
$a$(SELECT count(*) FROM filtrado WHERE motivo_conf IS NULL AND no_tipo)$a$),
  ('acoes_massivas_previa', 10,
$a$    'operador_email', v_operador$a$,
$a$    'operador_email', v_operador,
    -- Tipo de cobranca aplicado.
    'tipo_cobranca', v_tipo,
    -- Quantidade por tipo, com todos os demais filtros enviados ao banco e sem
    -- o limite da lista. Quem tem os dois tipos conta uma vez no total unico.
    'contagem_tipo', CASE WHEN v_tipo = 'REGRA_ANTERIOR' THEN NULL ELSE (
      SELECT jsonb_build_object(
        'mensalidades', count(*) FILTER (WHERE tem_mensalidade),
        'acordos_vencidos', count(*) FILTER (WHERE tem_acordo_vencido),
        'mensalidades_e_acordos_vencidos', count(*) FILTER (WHERE tem_mensalidade AND tem_acordo_vencido),
        'total_unico', count(*))
      FROM filtrado WHERE motivo_conf IS NULL) END$a$),
  -- -------------------------------------------------------------- exportar
  ('acoes_massivas_exportar', 1,
$a$p_operador_email text DEFAULT NULL::text)$a$,
$a$p_operador_email text DEFAULT NULL::text, p_tipo_cobranca text DEFAULT NULL::text)$a$),
  ('acoes_massivas_exportar', 2,
$a$  v_operador text := lower(nullif(btrim(p_operador_email), ''));$a$,
$a$  v_operador text := lower(nullif(btrim(p_operador_email), ''));
  v_tipo text := coalesce(upper(nullif(btrim(p_tipo_cobranca), '')), 'REGRA_ANTERIOR');
  v_tipo_ids text[] := '{}';
  v_exc_tipo int := 0;$a$),
  ('acoes_massivas_exportar', 3,
$a$  v_autor := case when v_sistema then 'SISTEMA' else lower(coalesce(auth.email(), '')) end;$a$,
$a$  if nullif(btrim(p_tipo_cobranca), '') is not null
     and v_tipo not in ('MENSALIDADES', 'ACORDOS_VENCIDOS', 'MENSALIDADES_E_ACORDOS') then
    raise exception 'Tipo de cobranca invalido: %', p_tipo_cobranca using errcode = '22023';
  end if;
  v_autor := case when v_sistema then 'SISTEMA' else lower(coalesce(auth.email(), '')) end;

  -- Tipo de cobranca: a mesma regra da previa, conferida agora.
  if v_tipo <> 'REGRA_ANTERIOR' then
    select coalesce(array_agg(tc.aluno_id::text), '{}') into v_tipo_ids
      from public.acoes_massivas_tipo_cobranca_alunos(v_ids::uuid[]) tc
     where public.acoes_massivas_tipo_cobranca_corresponde(v_tipo, tc.tem_mensalidade, tc.tem_acordo_vencido);
  end if;$a$),
  ('acoes_massivas_exportar', 4,
$a$    if exists (
      select 1 from public.alunos a
       where a.id = v_id::uuid$a$,
$a$    if v_tipo <> 'REGRA_ANTERIOR' and not (v_id = any(v_tipo_ids)) then
      v_exc_tipo := v_exc_tipo + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Não corresponde ao tipo de cobrança selecionado');
      continue;
    end if;

    if exists (
      select 1 from public.alunos a
       where a.id = v_id::uuid$a$),
  ('acoes_massivas_exportar', 5,
$a$      (canal, operador_email, arquivo, aluno_ids, total, exportado_por_email)
    values (v_canal, v_operador, p_arquivo, v_ok, array_length(v_ok, 1), v_autor)$a$,
$a$      (canal, operador_email, arquivo, aluno_ids, total, exportado_por_email, tipo_cobranca)
    values (v_canal, v_operador, p_arquivo, v_ok, array_length(v_ok, 1), v_autor, v_tipo)$a$),
  ('acoes_massivas_exportar', 6,
$a$    'excluidos_ja_acionados', v_exc_acionado,$a$,
$a$    'excluidos_ja_acionados', v_exc_acionado,
    'excluidos_tipo_cobranca', v_exc_tipo,
    'tipo_cobranca', v_tipo,$a$),
  -- -------------------------------------------------------------- concluir
  ('acoes_massivas_concluir_lote', 1,
$a$  v_reg jsonb;$a$,
$a$  v_reg jsonb;
  v_tipo_ids text[] := '{}';
  v_fora_tipo text[] := '{}';$a$),
  ('acoes_massivas_concluir_lote', 2,
$a$  v_reg := public.registrar_acao_massiva(v_ids, v_lote.canal, v_lote.arquivo, null, null, v_lote.operador_email);$a$,
$a$  -- Tipo de cobranca do lote, REVALIDADO agora no banco: quem nao corresponde
  -- mais (pagou a mensalidade, acertou a parcela, ficou com acordo em dia) sai.
  if v_lote.tipo_cobranca <> 'REGRA_ANTERIOR' then
    select coalesce(array_agg(tc.aluno_id::text), '{}') into v_tipo_ids
      from public.acoes_massivas_tipo_cobranca_alunos(v_ids::uuid[]) tc
     where public.acoes_massivas_tipo_cobranca_corresponde(v_lote.tipo_cobranca, tc.tem_mensalidade, tc.tem_acordo_vencido);
    v_fora_tipo := array(select x from unnest(v_ids) with ordinality as u(x, o)
                          where not (x = any(v_tipo_ids)) order by o);
    v_ids := array(select x from unnest(v_ids) with ordinality as u(x, o)
                    where x = any(v_tipo_ids) order by o);
  end if;

  v_reg := public.registrar_acao_massiva(v_ids, v_lote.canal, v_lote.arquivo, null, null, v_lote.operador_email);$a$),
  ('acoes_massivas_concluir_lote', 3,
$a$    'excluidos_acionados_apos_exportacao', coalesce(array_length(v_depois, 1), 0),$a$,
$a$    'excluidos_acionados_apos_exportacao', coalesce(array_length(v_depois, 1), 0),
    'tipo_cobranca', v_lote.tipo_cobranca,
    'excluidos_tipo_cobranca', coalesce(array_length(v_fora_tipo, 1), 0),
    'ids_fora_do_tipo_cobranca', to_jsonb(v_fora_tipo),$a$),
  -- ------------------------------------------------------------- pendentes
  ('acoes_massivas_lotes_pendentes', 1,
$a$             'operador_email', l.operador_email,$a$,
$a$             'operador_email', l.operador_email,
             'tipo_cobranca', l.tipo_cobranca,$a$);

  for v_fn, v_marca, v_muda_assin in
    select * from (values
      ('acoes_massivas_previa',          'p_tipo_cobranca',       true),
      ('acoes_massivas_exportar',        'p_tipo_cobranca',       true),
      ('acoes_massivas_concluir_lote',   'v_lote.tipo_cobranca',  false),
      ('acoes_massivas_lotes_pendentes', 'l.tipo_cobranca',       false)) t(fn, marca, muda)
  loop
    select count(*) into v_qtd
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn;
    if v_qtd <> 1 then
      raise exception '%: esperava exatamente 1 sobrecarga, achei % -- revise antes de aplicar', v_fn, v_qtd;
    end if;

    select p.oid, pg_get_functiondef(p.oid) into v_oid_antigo, v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn;

    if position(v_marca in v_def) > 0 then
      raise notice '% ja tem o filtro de tipo de cobranca; nada a fazer', v_fn;
      continue;
    end if;

    for r in select ancora, nova from _trocas_tipo where fn = v_fn order by ordem loop
      if (length(v_def) - length(replace(v_def, r.ancora, ''))) / length(r.ancora) <> 1 then
        raise exception '%: ancora nao encontrada exatamente uma vez -- a funcao mudou, revise: %',
          v_fn, left(r.ancora, 120);
      end if;
      v_def := replace(v_def, r.ancora, r.nova);
    end loop;

    v_comentario := obj_description(v_oid_antigo, 'pg_proc');
    execute v_def;

    if v_muda_assin then
      select p.oid into v_oid_novo
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_fn and p.oid <> v_oid_antigo;
      if v_oid_novo is null then
        raise exception '%: a assinatura nova nao foi criada', v_fn;
      end if;
      execute format('drop function %s', v_oid_antigo::regprocedure);
      execute format('revoke all on function %s from public, anon', v_oid_novo::regprocedure);
      execute format('grant execute on function %s to authenticated, service_role', v_oid_novo::regprocedure);
      if v_comentario is not null then
        execute format('comment on function %s is %L', v_oid_novo::regprocedure, v_comentario);
      end if;
    end if;
  end loop;
end $migration$;
