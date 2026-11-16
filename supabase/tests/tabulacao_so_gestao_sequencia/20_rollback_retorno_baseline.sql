-- Prova do rollback de 20261106120000 CONTRA O BASELINE (postgres, banco descartável do CI).
-- Esperado: antes -> RETORNO_FINANCEIRO ativa; depois do rollback -> ativa=false, MESMO número de linhas,
-- nenhuma outra tabulação alterada e nenhuma removida. "Desativar, nunca delete" (regra da casa).
\set ON_ERROR_STOP on
create temp table snap_antes as select codigo, ativa, somente_gestao, ordem from public.tabulacoes;
do $$ begin
  if not (select ativa from snap_antes where codigo = 'RETORNO_FINANCEIRO') then
    raise exception 'FALHOU pré: RETORNO_FINANCEIRO deveria estar ativa antes do rollback'; end if;
end $$;
\i supabase/aguardando_aprovacao/20261106120000_tabulacao_retorno_financeiro.rollback.sql
do $$
declare n_antes int; n_depois int; v_ativa boolean; v_outros int;
begin
  select count(*) into n_antes from snap_antes;
  select count(*) into n_depois from public.tabulacoes;
  if n_depois <> n_antes then raise exception 'FALHOU rollback: linhas removidas/criadas (% -> %)', n_antes, n_depois; end if;
  select ativa into v_ativa from public.tabulacoes where codigo = 'RETORNO_FINANCEIRO';
  if v_ativa is distinct from false then raise exception 'FALHOU rollback: RETORNO_FINANCEIRO continua ativa'; end if;
  select count(*) into v_outros from snap_antes s join public.tabulacoes t using (codigo)
   where s.codigo <> 'RETORNO_FINANCEIRO'
     and (s.ativa is distinct from t.ativa or s.somente_gestao is distinct from t.somente_gestao or s.ordem is distinct from t.ordem);
  if v_outros <> 0 then raise exception 'FALHOU rollback: % outras tabulações alteradas', v_outros; end if;
end $$;
select 'OK 20_rollback_retorno_baseline' as resultado;
