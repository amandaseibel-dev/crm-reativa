-- ROLLBACK de 20260916220000_acoes_massivas_filtro_tipo_cobranca.
--
-- Desfaz a cirurgia nas quatro funcoes (cada trecho novo volta a ser a ancora
-- original; previa e exportar voltam a assinatura sem p_tipo_cobranca, com a
-- mesma ACL), remove a funcao da regra e a coluna tipo_cobranca do lote.
--
-- ATENCAO: a coluna e removida -- lotes ja gravados perdem o tipo de cobranca
-- (ids, canal, operador, autoria e confirmacao ficam). Se o front com o filtro
-- estiver publicado, a previa com um tipo escolhido passa a falhar; com "Todos"
-- continua funcionando (o front so manda o parametro fora de "Todos").
--
-- O teste de comportamento prova que migration + rollback devolvem as funcoes
-- identicas as de antes.

do $rollback$
declare
  v_fn          text;
  v_marca       text;
  v_muda_assin  boolean;
  v_oid_com_tipo  oid;
  v_oid_sem_tipo    oid;
  v_def         text;
  v_qtd         int;
  v_comentario  text;
  r             record;
begin
  -- Os pares (ancora, nova) sao repetidos aqui de proposito: o rollback nao le
  -- arquivo. O teste confere que sao identicos aos da migration.
  create temp table _desfaz_tipo (fn text, ordem int, ancora text, nova text) on commit drop;

  insert into _desfaz_tipo values
  -- ---------------------------------------------------------------- previa
  ('acoes_massivas_previa', 1,
$a$p_operador_email text DEFAULT NULL::text)$a$,
$a$p_operador_email text DEFAULT NULL::text, p_tipo_cobranca text DEFAULT NULL::text)$a$),
  ('acoes_massivas_previa', 2,
$a$  v_operador text := lower(nullif(btrim(p_operador_email), ''));$a$,
$a$  v_operador text := lower(nullif(btrim(p_operador_email), ''));
  -- Tipo de cobranca escolhido na tela. NULL, vazio ou TODOS = regra atual.
  v_tipo text := upper(coalesce(nullif(btrim(p_tipo_cobranca), ''), 'TODOS'));$a$),
  ('acoes_massivas_previa', 3,
$a$  IF NOT v_sistema AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'Acesso negado: previa de acao massiva restrita a gestao.' USING ERRCODE = '42501';
  END IF;$a$,
$a$  IF NOT v_sistema AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'Acesso negado: previa de acao massiva restrita a gestao.' USING ERRCODE = '42501';
  END IF;
  IF v_tipo NOT IN ('TODOS', 'MENSALIDADES', 'ACORDOS', 'MENSALIDADES_E_ACORDOS') THEN
    RAISE EXCEPTION 'Tipo de cobranca invalido: %', p_tipo_cobranca USING ERRCODE = '22023';
  END IF;$a$),
  ('acoes_massivas_previa', 4,
$a$  liq_prime AS MATERIALIZED (
    SELECT lp.aluno_id FROM public.acoes_massivas_liquidados_prime() lp
  ),$a$,
$a$  liq_prime AS MATERIALIZED (
    SELECT lp.aluno_id FROM public.acoes_massivas_liquidados_prime() lp
  ),
  -- Alunos que correspondem ao tipo de cobranca. Em TODOS nem e calculado.
  tipo_ok AS MATERIALIZED (
    SELECT tc.aluno_id FROM public.acoes_massivas_tipo_cobranca_confere(v_tipo) tc
     WHERE v_tipo <> 'TODOS'
  ),$a$),
  ('acoes_massivas_previa', 5,
$a$      AND NOT EXISTS (SELECT 1 FROM public.acordos ac WHERE ac.aluno_id = a.id AND ac.status = 'ATIVO')$a$,
$a$      -- Acordo ativo fica fora em TODOS e MENSALIDADES, como sempre. Em ACORDOS e
      -- MENSALIDADES_E_ACORDOS entra so o acordo ativo com parcela vencida -- e
      -- isso quem garante e tipo_ok, abaixo.
      AND (v_tipo IN ('ACORDOS', 'MENSALIDADES_E_ACORDOS')
           OR NOT EXISTS (SELECT 1 FROM public.acordos ac WHERE ac.aluno_id = a.id AND ac.status = 'ATIVO'))
      AND (v_tipo = 'TODOS' OR EXISTS (SELECT 1 FROM tipo_ok tk WHERE tk.aluno_id = a.id))$a$),
  ('acoes_massivas_previa', 6,
$a$    'operador_email', v_operador$a$,
$a$    'operador_email', v_operador,
    -- Tipo de cobranca que a previa aplicou.
    'tipo_cobranca', v_tipo$a$),
  -- -------------------------------------------------------------- exportar
  ('acoes_massivas_exportar', 1,
$a$p_operador_email text DEFAULT NULL::text)$a$,
$a$p_operador_email text DEFAULT NULL::text, p_tipo_cobranca text DEFAULT NULL::text)$a$),
  ('acoes_massivas_exportar', 2,
$a$  v_operador text := lower(nullif(btrim(p_operador_email), ''));$a$,
$a$  v_operador text := lower(nullif(btrim(p_operador_email), ''));
  v_tipo text := upper(coalesce(nullif(btrim(p_tipo_cobranca), ''), 'TODOS'));
  v_tipo_ids text[] := '{}';
  v_exc_tipo int := 0;$a$),
  ('acoes_massivas_exportar', 3,
$a$  v_autor := case when v_sistema then 'SISTEMA' else lower(coalesce(auth.email(), '')) end;$a$,
$a$  if v_tipo not in ('TODOS', 'MENSALIDADES', 'ACORDOS', 'MENSALIDADES_E_ACORDOS') then
    raise exception 'Tipo de cobranca invalido: %', p_tipo_cobranca using errcode = '22023';
  end if;
  v_autor := case when v_sistema then 'SISTEMA' else lower(coalesce(auth.email(), '')) end;

  -- Tipo de cobranca: a mesma regra da previa, conferida agora.
  if v_tipo <> 'TODOS' then
    select coalesce(array_agg(tc.aluno_id::text), '{}') into v_tipo_ids
      from public.acoes_massivas_tipo_cobranca_confere(v_tipo, v_ids::uuid[]) tc;
  end if;$a$),
  ('acoes_massivas_exportar', 4,
$a$    if exists (
      select 1 from public.alunos a
       where a.id = v_id::uuid$a$,
$a$    if v_tipo <> 'TODOS' and not (v_id = any(v_tipo_ids)) then
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
  -- mais (pagou a mensalidade, acertou a parcela, fez acordo) fica de fora.
  if v_lote.tipo_cobranca <> 'TODOS' then
    select coalesce(array_agg(tc.aluno_id::text), '{}') into v_tipo_ids
      from public.acoes_massivas_tipo_cobranca_confere(v_lote.tipo_cobranca, v_ids::uuid[]) tc;
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

    select p.oid, pg_get_functiondef(p.oid) into v_oid_com_tipo, v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn;

    if position(v_marca in v_def) = 0 then
      raise notice '% nao tem o filtro de tipo de cobranca; nada a desfazer', v_fn;
      continue;
    end if;

    for r in select ancora, nova from _desfaz_tipo where fn = v_fn order by ordem desc loop
      if (length(v_def) - length(replace(v_def, r.nova, ''))) / length(r.nova) <> 1 then
        raise exception '%: trecho novo nao encontrado exatamente uma vez -- a funcao mudou, revise: %',
          v_fn, left(r.nova, 120);
      end if;
      v_def := replace(v_def, r.nova, r.ancora);
    end loop;

    v_comentario := obj_description(v_oid_com_tipo, 'pg_proc');
    execute v_def;

    if v_muda_assin then
      select p.oid into v_oid_sem_tipo
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_fn and p.oid <> v_oid_com_tipo;
      if v_oid_sem_tipo is null then
        raise exception '%: a assinatura antiga nao foi recriada', v_fn;
      end if;
      execute format('drop function %s', v_oid_com_tipo::regprocedure);
      execute format('revoke all on function %s from public, anon', v_oid_sem_tipo::regprocedure);
      execute format('grant execute on function %s to authenticated, service_role', v_oid_sem_tipo::regprocedure);
      if v_comentario is not null then
        execute format('comment on function %s is %L', v_oid_sem_tipo::regprocedure, v_comentario);
      end if;
    end if;
  end loop;
end $rollback$;

drop function if exists public.acoes_massivas_tipo_cobranca_confere(text, uuid[]);
alter table public.acoes_massivas_lotes drop constraint if exists acoes_massivas_lotes_tipo_cobranca_valido;
alter table public.acoes_massivas_lotes drop column if exists tipo_cobranca;
