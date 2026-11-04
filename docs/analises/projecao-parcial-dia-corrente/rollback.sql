-- ============================================================================
-- ROLLBACK DO PATCH 2 — volta ao estado do patch 1 (`REGRA 2026-11-03`):
-- dia corrente DENTRO da base do ritmo, numerador com o honorário do mês
-- inteiro e campo `projecao_parcial` no payload.
--
-- Isto NÃO devolve a premissa de agosto. Devolve o estado em que produção
-- estava em 04/11/2026 antes do patch 2 — o mesmo que fazia a projeção cair
-- pela metade na virada do dia. Para voltar mais atrás, é outro script.
--
-- Depois do rollback, REGERAR OS SNAPSHOTS (botão "Atualizar projeção" e
-- `tv_snapshot_atualizar`), senão as telas seguem lendo o payload do patch 2 —
-- e o campo `projecao_aguardando_fechamento` deixa de existir, então a tela
-- cai no caminho "sem selo", que é seguro (há teste para o campo ausente).
--
-- Rollback NÃO É RESTORE: PITR não está habilitado. É o inverso determinístico
-- do patch 2, provado byte a byte.
-- ============================================================================

begin;

do $rb$
declare
  v_def  text;
  v_novo text;
  v_cab  text;   -- comentário do patch 1, restaurado nas duas funções do CRM
begin

  v_cab :=
       '  -- REGRA 2026-11-03 (gestao): o DIA CORRENTE entra na base do ritmo.'    || E'\n'
    || '  -- A projecao existe desde o 1o dia util do mes, com o honorario que ja' || E'\n'
    || '  -- entrou, mesmo com o dia em andamento -- e fica marcada como PARCIAL'  || E'\n'
    || '  -- na tela enquanto o dia nao fechou (projecao_parcial).'                || E'\n'
    || '  -- Mes encerrado: v_du_pass ja e o total, projecao = realizado.'         || E'\n'
    || '  v_parcial := (v_hoje between v_ini and v_fim) and public.dias_uteis(v_hoje, v_hoje) = 1;' || E'\n';

  -- ==========================================================================
  -- 1) projecao_calcular_filial
  -- ==========================================================================
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'projecao_calcular_filial';
  if v_def is null then raise exception 'projecao_calcular_filial nao encontrada'; end if;
  v_novo := v_def;

  v_def := v_novo;
  v_novo := regexp_replace(v_novo,
    '[ \t]*--[^\n]*REGRA 2026-11-04[^\n]*\n([ \t]*--[^\n]*\n)*[ \t]*select coalesce\(sum\(valor_honorario\),0\) into v_hon_fec[ \t]*\n[ \t]*from public\.pagamentos[ \t]*\n[ \t]*where data_pagamento >= v_ini and data_pagamento <= least\(v_hoje - 1, v_fim\);[ \t]*\n[ \t]*v_aguardando := \(v_du_pass = 0\);[ \t]*\n',
    v_cab);
  if v_novo = v_def then
    raise exception 'ROLLBACK: ancora 1 (bloco do patch 2) nao casou em projecao_calcular_filial';
  end if;

  v_novo := replace(v_novo,
    'v_du_pass  := public.dias_uteis(v_ini, least(v_hoje - 1, v_fim));',
    'v_du_pass  := public.dias_uteis(v_ini, least(v_hoje, v_fim));');
  v_novo := replace(v_novo,
    'v_du_rest int; v_du_pass int; v_du_total int; v_aguardando boolean; v_hon_fec numeric;',
    'v_du_rest int; v_du_pass int; v_du_total int; v_parcial boolean;');
  v_novo := replace(v_novo,
    '  v_proj_filial := case when v_du_pass > 0 then round((v_hon_fec / v_du_pass) * v_du_total, 2) else null end;',
    '  v_proj_filial := case when v_du_pass > 0 then round((v_hon_mes / v_du_pass) * v_du_total, 2) else v_hon_mes end;');
  v_novo := replace(v_novo,
    '''projecao_aguardando_fechamento'', v_aguardando,',
    '''projecao_parcial'', v_parcial,');

  if strpos(v_novo, 'v_hon_fec') > 0 or strpos(v_novo, 'v_aguardando') > 0
     or strpos(v_novo, 'REGRA 2026-11-04') > 0 then
    raise exception 'ROLLBACK: sobrou patch 2 em projecao_calcular_filial';
  end if;
  if strpos(v_novo, 'REGRA 2026-11-03') = 0 then
    raise exception 'ROLLBACK: bloco do patch 1 nao voltou em projecao_calcular_filial';
  end if;
  execute v_novo;
  raise notice 'rollback do patch 2 aplicado: projecao_calcular_filial(text)';

  -- ==========================================================================
  -- 2) projecao_calcular_operador
  -- ==========================================================================
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'projecao_calcular_operador';
  if v_def is null then raise exception 'projecao_calcular_operador nao encontrada'; end if;
  v_novo := v_def;

  v_def := v_novo;
  v_novo := regexp_replace(v_novo,
    '[ \t]*--[^\n]*REGRA 2026-11-04[^\n]*\n([ \t]*--[^\n]*\n)*[ \t]*select coalesce\(sum\(valor_honorario\),0\) into v_hon_fec[ \t]*\n[ \t]*from public\.pagamentos[ \t]*\n[ \t]*where data_pagamento >= v_ini and data_pagamento <= least\(v_hoje - 1, v_fim\)[ \t]*\n[ \t]*and \( \(v_sem and operador_email is null\)[ \t]*\n[ \t]*or \(not v_sem and lower\(operador_email\) = p_email\) \);[ \t]*\n[ \t]*v_aguardando := \(v_du_pass = 0\);[ \t]*\n',
    v_cab);
  if v_novo = v_def then
    raise exception 'ROLLBACK: ancora 2 (bloco do patch 2) nao casou em projecao_calcular_operador';
  end if;

  v_novo := replace(v_novo,
    'v_du_pass  := public.dias_uteis(v_ini, least(v_hoje - 1, v_fim));',
    'v_du_pass  := public.dias_uteis(v_ini, least(v_hoje, v_fim));');
  v_novo := replace(v_novo,
    'v_du_rest int; v_du_pass int; v_du_total int; v_aguardando boolean; v_hon_fec numeric;',
    'v_du_rest int; v_du_pass int; v_du_total int; v_parcial boolean;');
  v_novo := replace(v_novo,
    '    v_proj_ind := case when v_du_pass > 0 then round((v_hon_fec / v_du_pass) * v_du_total, 2) else null end;',
    '    v_proj_ind := case when v_du_pass > 0 then round((v_hon_mes / v_du_pass) * v_du_total, 2) else v_hon_mes end;');
  v_novo := replace(v_novo,
    '''projecao_aguardando_fechamento'', v_aguardando,',
    '''projecao_parcial'', v_parcial,');

  if strpos(v_novo, 'v_hon_fec') > 0 or strpos(v_novo, 'v_aguardando') > 0
     or strpos(v_novo, 'REGRA 2026-11-04') > 0 then
    raise exception 'ROLLBACK: sobrou patch 2 em projecao_calcular_operador';
  end if;
  if strpos(v_novo, 'REGRA 2026-11-03') = 0 then
    raise exception 'ROLLBACK: bloco do patch 1 nao voltou em projecao_calcular_operador';
  end if;
  execute v_novo;
  raise notice 'rollback do patch 2 aplicado: projecao_calcular_operador(text,text)';

  -- ==========================================================================
  -- 3) tv_snapshot_calcular
  -- ==========================================================================
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular';
  if v_def is null then raise exception 'tv_snapshot_calcular nao encontrada'; end if;
  v_novo := v_def;

  v_def := v_novo;
  v_novo := regexp_replace(v_novo,
    '[ \t]*--[^\n]*REGRA 2026-11-04[^\n]*\n([ \t]*--[^\n]*\n)*[ \t]*v_du_rest := public\.dias_uteis\(current_date[^\n]*\n[ \t]*select coalesce\(round\(sum\(valor_pago\)\),0\)::bigint[^\n]*\n[ \t]*into v_rec_fec, v_hon_fec[ \t]*\n[ \t]*from public\.pagamentos where data_pagamento is not null[ \t]*\n[ \t]*and date_trunc[^\n]*\n[ \t]*and data_pagamento <= current_date - 1;[ \t]*\n[ \t]*v_aguardando := \(v_du_ate = 0\);[ \t]*\n',
       '  -- REGRA 2026-11-03 (gestao): o DIA CORRENTE entra na base do ritmo'   || E'\n'
    || '  -- (v_du_ate ja inclui hoje), para a projecao existir desde o 1o dia'  || E'\n'
    || '  -- util. "Restantes" segue contando hoje -- o dia ainda vai fechar --' || E'\n'
    || '  -- pela mesma formula do CRM, para TV e CRM nao divergirem.'           || E'\n'
    || '  v_du_rest := public.dias_uteis(current_date, (date_trunc(''month'',current_date) + interval ''1 month - 1 day'')::date);' || E'\n'
    || '  v_parcial := public.dias_uteis(current_date, current_date) = 1;'       || E'\n');
  if v_novo = v_def then
    raise exception 'ROLLBACK: ancora 3 (bloco do patch 2) nao casou na TV';
  end if;

  v_novo := replace(v_novo,
    'least(current_date - 1, (date_trunc(''month'',current_date) + interval ''1 month - 1 day'')::date)',
    'least(current_date, (date_trunc(''month'',current_date) + interval ''1 month - 1 day'')::date)');
  v_novo := replace(v_novo,
    'v_du_mes int; v_du_ate int; v_du_rest int; v_aguardando boolean; v_rec_fec bigint; v_hon_fec bigint;',
    'v_du_mes int; v_du_ate int; v_du_rest int; v_parcial boolean;');
  v_novo := replace(v_novo,
    '  v_proj_rec := case when v_du_ate > 0 then round(v_rec_fec::numeric / v_du_ate * v_du_mes) else null end;',
    '  v_proj_rec := case when v_du_ate > 0 then round(v_rec::numeric / v_du_ate * v_du_mes) else v_rec end;');
  v_novo := replace(v_novo,
    '  v_proj_hon := case when v_du_ate > 0 then round(v_hon_fec::numeric / v_du_ate * v_du_mes) else null end;',
    '  v_proj_hon := case when v_du_ate > 0 then round(v_hon::numeric / v_du_ate * v_du_mes) else v_hon end;');
  v_novo := replace(v_novo,
    '  v_proj_fech := case when v_du_ate > 0 then round(v_rec_fec::numeric / v_du_ate * v_du_mes) else null end;',
    '  v_proj_fech := case when v_du_ate > 0 then round(v_media_dia * v_du_mes) else v_rec end;');
  v_novo := replace(v_novo,
    '''projecao_aguardando_fechamento'', v_aguardando,',
    '''projecao_parcial'', v_parcial,');

  if strpos(v_novo, 'v_hon_fec') > 0 or strpos(v_novo, 'v_rec_fec') > 0
     or strpos(v_novo, 'v_aguardando') > 0 or strpos(v_novo, 'REGRA 2026-11-04') > 0 then
    raise exception 'ROLLBACK: sobrou patch 2 na TV';
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
