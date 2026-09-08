-- Rollback de 20260908180000_acoes_massivas_exclui_liquidados_no_prime.
-- Desfaz as seis trocas de texto nas definicoes vivas (mesmas ancoras, no
-- sentido inverso) e apaga a funcao de regra. Nenhum dado foi alterado pela
-- migration, entao nao ha o que restaurar em tabela.
do $rollback$
declare v_def text; r record; fn text;
begin
  create temp table if not exists _trocas (fn text, ancora text, nova text) on commit drop;
  delete from _trocas;
  insert into _trocas values
  ('acoes_massivas_previa',
$a$
  -- Quem ja consta liquidado no Prime nao entra, nem aparece (Amanda, 08/09).
  liq_prime AS MATERIALIZED (
    SELECT lp.aluno_id FROM public.acoes_massivas_liquidados_prime() lp
  ),$a$, ''),
  ('acoes_massivas_previa',
$a$      AND NOT EXISTS (SELECT 1 FROM liq_prime lp WHERE lp.aluno_id = a.id)
$a$, ''),
  ('acoes_massivas_previa',
$a$
    'prime_extrato_em', (SELECT max(e.coletado_em)::date FROM public.prime_extrato e),$a$, ''),
  ('registrar_acao_massiva',
$a$
  v_liq_ids text[]; v_excluidos_liq int := 0;$a$, ''),
  ('registrar_acao_massiva',
$a$  -- Revalida contra o Prime na hora de gravar: quem ja consta liquidado la
  -- nao recebe cobranca em massa (Amanda, 08/09). Nada e gravado para ele.
  SELECT COALESCE(array_agg(lp.aluno_id::text), '{}') INTO v_liq_ids
    FROM public.acoes_massivas_liquidados_prime(COALESCE(p_aluno_ids, '{}'::text[])::uuid[]) lp;

  FOREACH v_id IN ARRAY COALESCE(p_aluno_ids, '{}'::text[]) LOOP
    IF v_id = ANY(v_liq_ids) THEN
      v_excluidos_liq := v_excluidos_liq + 1;
      v_excluidos := v_excluidos || jsonb_build_object('aluno_id', v_id, 'motivo', 'Já consta liquidado no Prime');
      CONTINUE;
    END IF;
$a$,
$a$  FOREACH v_id IN ARRAY COALESCE(p_aluno_ids, '{}'::text[]) LOOP
$a$),
  ('registrar_acao_massiva',
$a$
    'excluidos_liquidados_prime', v_excluidos_liq,$a$, '');
  for fn in select distinct _trocas.fn from _trocas loop
    select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = fn;
    for r in select ancora, nova from _trocas where _trocas.fn = fn loop
      if (length(v_def) - length(replace(v_def, r.ancora, ''))) / length(r.ancora) <> 1 then
        raise exception '%: ancora nao encontrada exatamente uma vez', fn;
      end if;
      v_def := replace(v_def, r.ancora, r.nova);
    end loop;
    execute v_def;
  end loop;
end $rollback$;
drop function if exists public.acoes_massivas_liquidados_prime(uuid[]);
