-- ============================================================================
-- ROLLBACK DO PATCH 2 — volta a base do ritmo para o estado do patch 1
-- (dia corrente DENTRO da base, `REGRA 2026-11-03`).
--
-- Isto NÃO devolve a premissa de agosto. Devolve o estado em que produção
-- estava em 04/11/2026 antes do patch 2: dia corrente contando como divisor,
-- que é o que fazia a projeção cair pela metade na virada do dia. Se for para
-- voltar mais atrás que isso, é outro script.
--
-- Depois do rollback, REGERAR OS SNAPSHOTS (botão "Atualizar projeção" e
-- tv_snapshot_atualizar), senão as telas seguem mostrando o número do patch 2.
--
-- Rollback NÃO É RESTORE: PITR não está habilitado. Isto é o inverso
-- determinístico do patch 2, provado byte a byte, não uma volta no tempo.
-- ============================================================================

begin;

do $rb$
declare
  v_rec  record;
  v_def  text;
  v_novo text;
begin

  -- ==========================================================================
  -- 1) CRM — projecao_calcular_filial e projecao_calcular_operador
  -- ==========================================================================
  for v_rec in
    select p.oid::regprocedure::text as assinatura,
           pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('projecao_calcular_filial', 'projecao_calcular_operador')
    order by p.proname
  loop
    v_def := v_rec.def;

    v_novo := regexp_replace(
      v_def,
      '[ \t]*--[^\n]*REGRA 2026-11-04[^\n]*\n([ \t]*--[^\n]*\n)*[ \t]*if v_hoje <= v_fim then[ \t]*\n[ \t]*v_du_pass := greatest\(public\.dias_uteis\(v_ini, v_hoje - 1\), 1\);[ \t]*\n[ \t]*end if;[ \t]*\n[ \t]*v_parcial := \(v_hoje between v_ini and v_fim\)[^\n]*\n',
         '  -- REGRA 2026-11-03 (gestao): o DIA CORRENTE entra na base do ritmo.'    || E'\n'
      || '  -- A projecao existe desde o 1o dia util do mes, com o honorario que ja' || E'\n'
      || '  -- entrou, mesmo com o dia em andamento -- e fica marcada como PARCIAL'  || E'\n'
      || '  -- na tela enquanto o dia nao fechou (projecao_parcial).'                || E'\n'
      || '  -- Mes encerrado: v_du_pass ja e o total, projecao = realizado.'         || E'\n'
      || '  v_parcial := (v_hoje between v_ini and v_fim) and public.dias_uteis(v_hoje, v_hoje) = 1;' || E'\n'
    );
    if v_novo = v_def then
      raise exception 'ROLLBACK: ancora 1 nao casou em % (patch 2 nao aplicado?)', v_rec.assinatura;
    end if;

    if strpos(v_novo, 'v_hoje - 1') > 0 then
      raise exception 'ROLLBACK: base por dia fechado sobrou em %', v_rec.assinatura;
    end if;
    if strpos(v_novo, 'REGRA 2026-11-03') = 0 then
      raise exception 'ROLLBACK: bloco do patch 1 nao voltou em %', v_rec.assinatura;
    end if;

    execute v_novo;
    raise notice 'rollback do patch 2 aplicado: %', v_rec.assinatura;
  end loop;

  -- ==========================================================================
  -- 2) TV — tv_snapshot_calcular
  -- ==========================================================================
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular';

  if v_def is null then
    raise exception 'tv_snapshot_calcular nao encontrada';
  end if;

  v_novo := regexp_replace(
    v_def,
    '[ \t]*--[^\n]*REGRA 2026-11-04[^\n]*\n([ \t]*--[^\n]*\n)*[ \t]*v_du_ate := greatest\(public\.dias_uteis\(date_trunc\(''month'',current_date\)::date, current_date - 1\), 1\);[ \t]*\n[ \t]*v_du_rest := public\.dias_uteis\(current_date[^\n]*\n[ \t]*v_parcial := public\.dias_uteis\(current_date, current_date\) = 1;[ \t]*\n',
       '  -- REGRA 2026-11-03 (gestao): o DIA CORRENTE entra na base do ritmo'   || E'\n'
    || '  -- (v_du_ate ja inclui hoje), para a projecao existir desde o 1o dia'  || E'\n'
    || '  -- util. "Restantes" segue contando hoje -- o dia ainda vai fechar --' || E'\n'
    || '  -- pela mesma formula do CRM, para TV e CRM nao divergirem.'           || E'\n'
    || '  v_du_rest := public.dias_uteis(current_date, (date_trunc(''month'',current_date) + interval ''1 month - 1 day'')::date);' || E'\n'
    || '  v_parcial := public.dias_uteis(current_date, current_date) = 1;'       || E'\n'
  );
  if v_novo = v_def then
    raise exception 'ROLLBACK: ancora 2 nao casou (patch 2 nao aplicado?)';
  end if;

  if strpos(v_novo, 'current_date - 1') > 0 then
    raise exception 'ROLLBACK: base por dia fechado sobrou na TV';
  end if;
  if strpos(v_novo, 'REGRA 2026-11-03') = 0 then
    raise exception 'ROLLBACK: bloco do patch 1 nao voltou na TV';
  end if;

  execute v_novo;
  raise notice 'rollback do patch 2 aplicado: tv_snapshot_calcular()';
end
$rb$;

-- grants, de novo (o CREATE OR REPLACE do rollback também os devolve a PUBLIC)
revoke all on function public.projecao_calcular_filial(text)        from public, anon, authenticated;
revoke all on function public.projecao_calcular_operador(text,text) from public, anon, authenticated;
grant execute on function public.projecao_calcular_filial(text)        to service_role;
grant execute on function public.projecao_calcular_operador(text,text) to service_role;

revoke all on function public.tv_snapshot_calcular() from public, anon;
grant execute on function public.tv_snapshot_calcular() to authenticated, service_role;

commit;
