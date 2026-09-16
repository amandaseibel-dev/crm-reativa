-- Acoes Massivas: filtro "Tipo de cobranca".
--
-- Amanda, 16/09/2026: incluir o filtro Tipo de cobranca, funcionando junto com
-- todos os filtros (inclusive operador), igual na previa, na exportacao e na
-- confirmacao do lote.
--
-- OPCOES (decididas por ela em 16/09, com os numeros na mao)
--   TODOS                   a regra de sempre, sem filtrar pelo tipo.
--   MENSALIDADES            tem mensalidade em aberto e NAO tem acordo ativo.
--   ACORDOS                 tem acordo ATIVO com parcela VENCIDA e NAO tem
--                           mensalidade em aberto.
--   MENSALIDADES_E_ACORDOS  tem as duas coisas ao mesmo tempo.
-- As opcoes sao EXCLUSIVAS: ninguem cai em duas.
--
-- A TRAVA DO ACORDO ATIVO. A previa sempre tirou quem tem acordo ATIVO -- e
-- parcela de acordo em aberto so existe em acordo ATIVO (medido em 16/09: 9.343
-- parcelas A_VENCER/VENCIDA em acordo ATIVO, 6 em CANCELADO). Mantida a trava,
-- "Somente acordos" sairia sempre vazia. Decisao dela: nas opcoes ACORDOS e
-- MENSALIDADES_E_ACORDOS entra so o acordo ATIVO com parcela VENCIDA; acordo em
-- dia continua fora. TODOS e MENSALIDADES mantem a trava exatamente como hoje.
-- Medido em 16/09 (leitura, com as demais travas): 845 alunos saiam pela trava;
-- 801 com parcela vencida, 44 em dia ou sem parcela aberta.
--
-- DEFINICOES (as mesmas do saldo canonico, aluno_saldo_pendente_detalhe):
--   mensalidade em aberto = acordos_titulos com situacao ABERTO ou NEGOCIADO,
--     status diferente de quitada, tipo_boleto diferente de 'Acordo', saldo
--     cobravel > 0 e SEM vinculo ativo com acordo nao cancelado;
--   acordo com parcela vencida = acordo ATIVO com parcela em status VENCIDA.
-- A regra mora numa funcao so, `acoes_massivas_tipo_cobranca_confere`, usada
-- pela previa, pela exportacao e pela confirmacao.
--
-- O QUE MUDA
--   * acoes_massivas_previa ganha `p_tipo_cobranca text default null` (NULL,
--     vazio ou TODOS = regra atual) e devolve `tipo_cobranca`;
--   * acoes_massivas_exportar ganha o mesmo parametro, revalida o tipo e grava
--     o tipo no lote;
--   * acoes_massivas_lotes ganha a coluna `tipo_cobranca` (TODOS para os lotes
--     que ja existirem);
--   * acoes_massivas_concluir_lote REVALIDA o tipo do lote no banco antes de
--     registrar: quem nao corresponde mais fica de fora e e contado;
--   * acoes_massivas_lotes_pendentes mostra o tipo.
--
-- NAO MUDA: titulos, acordos, parcelas, valores e responsaveis. Tudo aqui so le
-- essas tabelas.
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

-- 1) A regra, num lugar so. Devolve so ids.
create or replace function public.acoes_massivas_tipo_cobranca_confere(p_tipo text, p_aluno_ids uuid[] default null)
returns table(aluno_id uuid)
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
  )
  select m.aluno_id from mens m
   where upper(p_tipo) = 'MENSALIDADES'
     and not exists (select 1 from ativo x where x.aluno_id = m.aluno_id)
  union
  select v.aluno_id from vencido v
   where upper(p_tipo) = 'ACORDOS'
     and not exists (select 1 from mens m where m.aluno_id = v.aluno_id)
  union
  select v.aluno_id from vencido v
   where upper(p_tipo) = 'MENSALIDADES_E_ACORDOS'
     and exists (select 1 from mens m where m.aluno_id = v.aluno_id);
$function$;

revoke all on function public.acoes_massivas_tipo_cobranca_confere(text, uuid[]) from public, anon, authenticated;
grant execute on function public.acoes_massivas_tipo_cobranca_confere(text, uuid[]) to service_role;

-- 2) O lote guarda o tipo.
alter table public.acoes_massivas_lotes
  add column if not exists tipo_cobranca text not null default 'TODOS';
do $chk$
begin
  if not exists (select 1 from pg_constraint where conname = 'acoes_massivas_lotes_tipo_cobranca_valido') then
    alter table public.acoes_massivas_lotes
      add constraint acoes_massivas_lotes_tipo_cobranca_valido
      check (tipo_cobranca in ('TODOS', 'MENSALIDADES', 'ACORDOS', 'MENSALIDADES_E_ACORDOS'));
  end if;
end $chk$;

-- 3) Cirurgia nas quatro funcoes.
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
