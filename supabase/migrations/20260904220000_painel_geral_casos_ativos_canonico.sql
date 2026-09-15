-- Painel Geral: "Casos ativos" contava pelo TEXTO do status do aluno
-- (fora só QUITAD/JURIDICO/CANCEL). SEM_SALDO_EM_ABERTO, AGUARDANDO_BAIXA,
-- SUSPENSAO_COBRANCA e ENCERRADO entravam como ativos: 15.716 no card contra
-- 12.402 alunos com caso realmente ativo (04/09/2026, depois do encerramento
-- em massa dos zerados). A Amanda viu o número não cair e tinha razão.
--
-- Regra única: aluno ativo = tem pelo menos um caso com
-- encerrado_operacional = false (a mesma da contagem dos 500 e da Saúde da
-- Carteira). Vale para o card e para a tabela "Casos ativos por operador".
--
-- Visão 360 / dashboard_gestao_geral: "Já recuperados" passa a contar também
-- SEM_SALDO_EM_ABERTO e SALDO_ZERO_CONFIRMADO; "ativos" usa a mesma regra do
-- caso ativo.
--
-- Feito por substituição textual sobre a definição atual (com trava: se o
-- trecho esperado não estiver lá exatamente 1x, a migration falha em vez de
-- gravar uma função pela metade). A função resultante fica em prod; auditar
-- por objeto.

do $$
declare
  v_src text;
  v_new text;
  v_a text := $t$    select a.*,
      upper(coalesce(a.status_atual,'')||' '||coalesce(a.status_jornada,'')||' '||coalesce(a.status_acionamento,'')) as st
    from public.alunos a$t$;
  v_a2 text := $t$    select a.*,
      upper(coalesce(a.status_atual,'')||' '||coalesce(a.status_jornada,'')||' '||coalesce(a.status_acionamento,'')) as st,
      -- Ativo = tem caso aberto na carteira. Nada de ler status textual.
      exists (select 1 from public.casos c
               where c.aluno_id = a.id and not coalesce(c.encerrado_operacional,false)) as ativo
    from public.alunos a$t$;
  v_b text := $t$where st not like '%QUITAD%' and st not like '%JURIDICO%' and st not like '%CANCEL%'$t$;
  v_b2 text := $t$where ativo$t$;
begin
  if to_regprocedure('public.painel_geral(text,text)') is null then
    raise notice 'painel_geral nao existe aqui; nada a fazer.';
  else
    select pg_get_functiondef('public.painel_geral(text,text)'::regprocedure) into v_src;
    if (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a) <> 1 then
      raise exception 'painel_geral: CTE classificado nao encontrada exatamente 1x; revisar migration.';
    end if;
    if (length(v_src) - length(replace(v_src, v_b, ''))) / length(v_b) <> 2 then
      raise exception 'painel_geral: filtro de status nao encontrado exatamente 2x; revisar migration.';
    end if;
    v_new := replace(replace(v_src, v_a, v_a2), v_b, v_b2);
    execute v_new;
  end if;
end $$;

do $$
declare
  v_src text;
  v_new text;
  v_q text := $t$'quitados', count(*) filter (where status_atual ilike 'QUIT%' or status_atual='BAIXA_REALIZADA' or status_jornada ilike 'QUIT%' or status_jornada='BAIXA_REALIZADA'),$t$;
  v_q2 text := $t$'quitados', count(*) filter (where status_atual ilike 'QUIT%' or status_atual='BAIXA_REALIZADA' or status_jornada ilike 'QUIT%' or status_jornada='BAIXA_REALIZADA'
                                  or status_atual in ('SEM_SALDO_EM_ABERTO','SALDO_ZERO_CONFIRMADO') or status_jornada in ('SEM_SALDO_EM_ABERTO','SALDO_ZERO_CONFIRMADO')),$t$;
  v_t text := $t$'ativos', count(*) filter (where not (status_atual ilike 'QUIT%' or status_atual='BAIXA_REALIZADA' or status_jornada ilike 'QUIT%' or status_jornada='BAIXA_REALIZADA')),$t$;
  v_t2 text := $t$'ativos', count(*) filter (where exists (select 1 from public.casos c where c.aluno_id = alunos.id and not coalesce(c.encerrado_operacional,false))),$t$;
begin
  if to_regprocedure('public.dashboard_gestao_geral_impl(integer)') is null then
    raise notice 'dashboard_gestao_geral_impl nao existe aqui; nada a fazer.';
  else
    select pg_get_functiondef('public.dashboard_gestao_geral_impl(integer)'::regprocedure) into v_src;
    if (length(v_src) - length(replace(v_src, v_q, ''))) / length(v_q) <> 1
       or (length(v_src) - length(replace(v_src, v_t, ''))) / length(v_t) <> 1 then
      raise exception 'dashboard_gestao_geral_impl: trechos quitados/ativos nao encontrados exatamente 1x; revisar migration.';
    end if;
    v_new := replace(replace(v_src, v_q, v_q2), v_t, v_t2);
    execute v_new;
  end if;
end $$;
