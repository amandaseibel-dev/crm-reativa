-- ============================================================================
-- ROLLBACK da proposta.sql — volta à premissa de 2026-08-17 ("só dia fechado
-- entra no ritmo"), tira projecao_parcial do payload e devolve v_hoje ao
-- current_date. Patch ancorado no sentido inverso, com as mesmas guardas.
--
-- Rodar somente se a regra nova for recusada. Depois do rollback, regerar os
-- snapshots (botão "Atualizar projeção" + tv_snapshot_atualizar), senão as telas
-- seguem lendo o payload com a flag.
--
-- Rollback NÃO É RESTORE: PITR não está habilitado. Isto aqui é o inverso
-- determinístico do patch, não uma volta no tempo do banco.
-- ============================================================================

begin;

do $rb$
declare
  v_rec   record;
  v_def   text;
  v_novo  text;
  v_bloco text;
begin

  -- ==========================================================================
  -- 1) CRM — projecao_calcular_filial e projecao_calcular_operador
  -- ==========================================================================
  v_bloco :=
       '  -- PREMISSA 2026-08-17: 1 DIA UTIL A MENOS -- so dia FECHADO entra no ritmo.' || E'\n'
    || '  -- Boleto (e parte dos cartoes) cai em D+1; no proprio dia entra basicamente'  || E'\n'
    || '  -- PIX, entao o dia corrente esta incompleto e nao pode virar base de ritmo.'  || E'\n'
    || '  -- Mes ja encerrado nao sofre desconto (todos os dias fecharam).'              || E'\n'
    || '  if v_hoje <= v_fim then v_du_pass := greatest(v_du_pass - 1, 0); end if;'      || E'\n';

  for v_rec in
    select p.oid::regprocedure::text as assinatura,
           pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('projecao_calcular_filial', 'projecao_calcular_operador')
    order by p.proname
  loop
    v_def  := v_rec.def;
    v_novo := v_def;

    -- 1.a  volta o desconto do dia corrente, sai a atribuição de v_parcial
    v_novo := regexp_replace(
      v_novo,
      '[ \t]*--[^\n]*REGRA 2026-11-03[^\n]*\n([ \t]*--[^\n]*\n)*[ \t]*v_parcial := \(v_hoje between v_ini and v_fim\)[^\n]*\n',
      v_bloco
    );
    if v_novo = v_def then
      raise exception 'ROLLBACK: ancora 1.a nao casou em % (patch nao aplicado?)', v_rec.assinatura;
    end if;

    -- 1.b  declaração
    v_novo := replace(
      v_novo,
      'v_du_rest int; v_du_pass int; v_du_total int; v_parcial boolean;',
      'v_du_rest int; v_du_pass int; v_du_total int;'
    );

    -- 1.c  dia corrente volta a ser UTC (como era antes do patch)
    v_novo := replace(
      v_novo,
      'v_hoje date := (now() at time zone ''America/Sao_Paulo'')::date;',
      'v_hoje date := current_date;'
    );

    -- 1.d  sai do payload
    v_novo := replace(
      v_novo,
      '''projecao_parcial'', v_parcial,' || E'\n    ' || '''dias_uteis_passados'', v_du_pass,',
      '''dias_uteis_passados'', v_du_pass,'
    );

    if strpos(v_novo, 'projecao_parcial') > 0 or strpos(v_novo, 'v_parcial') > 0 then
      raise exception 'ROLLBACK: sobrou v_parcial em %', v_rec.assinatura;
    end if;
    if strpos(v_novo, 'v_du_pass - 1') = 0 then
      raise exception 'ROLLBACK: desconto nao voltou em %', v_rec.assinatura;
    end if;

    execute v_novo;
    raise notice 'rollback aplicado: %', v_rec.assinatura;
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
  v_novo := v_def;

  v_novo := regexp_replace(
    v_novo,
    '[ \t]*--[^\n]*REGRA 2026-11-03[^\n]*\n([ \t]*--[^\n]*\n)*[ \t]*v_du_rest := public\.dias_uteis\(current_date[^\n]*\n[ \t]*v_parcial := public\.dias_uteis\(current_date, current_date\) = 1;[ \t]*\n',
       '  -- PREMISSA 2026-08-17: 1 DIA UTIL A MENOS -- so dia FECHADO entra no ritmo.' || E'\n'
    || '  -- Boleto (e parte dos cartoes) cai em D+1; no proprio dia entra basicamente PIX.' || E'\n'
    || '  v_du_ate := greatest(0, v_du_ate - 1);'          || E'\n'
    || '  v_du_rest := greatest(0, v_du_mes - v_du_ate);'   || E'\n'
  );
  if v_novo = v_def then
    raise exception 'ROLLBACK: ancora 2 nao casou (patch nao aplicado?)';
  end if;

  v_novo := replace(
    v_novo,
    'v_du_mes int; v_du_ate int; v_du_rest int; v_parcial boolean;',
    'v_du_mes int; v_du_ate int; v_du_rest int;'
  );
  v_novo := replace(
    v_novo,
    '''projecao_parcial'', v_parcial,' || E'\n    ' || '''dias_restantes'', v_du_rest, ''dias_uteis_mes'', v_du_mes,',
    '''dias_restantes'', v_du_rest, ''dias_uteis_mes'', v_du_mes,'
  );
  v_novo := replace(
    v_novo,
    '''projecao_parcial'', v_parcial,' || E'\n    ' || '''dias_uteis_mes'', v_du_mes, ''dias_uteis_transcorridos'', v_du_ate, ''dias_uteis_restantes'', v_du_rest,',
    '''dias_uteis_mes'', v_du_mes, ''dias_uteis_transcorridos'', v_du_ate, ''dias_uteis_restantes'', v_du_rest,'
  );

  if strpos(v_novo, 'projecao_parcial') > 0 or strpos(v_novo, 'v_parcial') > 0 then
    raise exception 'ROLLBACK: sobrou v_parcial na TV';
  end if;
  if strpos(v_novo, 'v_du_ate - 1') = 0 then
    raise exception 'ROLLBACK: desconto nao voltou na TV';
  end if;

  execute v_novo;
  raise notice 'rollback aplicado: tv_snapshot_calcular()';
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
