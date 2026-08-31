-- DESFAZER 20260831150000_acordo_quitado_nao_conta_no_saldo.sql
--
-- ATENCAO: desfazer faz acordo QUITADO voltar a gerar cobranca sempre que uma
-- parcela dele nao estiver marcada PAGO -- contra a regra da Amanda de 31/08
-- ("se ja esta quitado ou cancelado nao devem ir para contagem").
--
-- Em 31/08 isso afetava um unico aluno (Lucas Goncalves dos Santos, R$ 1.844,42),
-- mas a exposicao cresce a cada acordo quitado com parcela mal marcada.

do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'recalcular_situacao_aluno';

  v_novo := replace(v_def,
    'upper(coalesce(a.status,'''')) not in (''CANCELADO'',''CANCELADA'',''QUITADO'')',
    'upper(coalesce(a.status,'''')) not in (''CANCELADO'',''CANCELADA'')');

  if v_novo = v_def then
    raise exception 'nada a desfazer -- a funcao nao esta na versao corrigida';
  end if;

  execute v_novo;
end $do$;

-- e recalcular:
-- select public.recalcular_situacao_virada_diaria('rollback_quitado_conta');
