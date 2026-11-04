-- ============================================================================
-- PATCH 2 — PROJEÇÃO SOMENTE POR DIAS ÚTEIS EFETIVAMENTE FECHADOS
-- Regra aprovada pela gestão em 04/11/2026.
--
-- NÃO APLICADO. Proposta para a Amanda aplicar (R5/P3 do Guardião: nesta fase
-- nenhum agente escreve migration; o caminho autorizado é propor o SQL).
--
-- ----------------------------------------------------------------------------
-- A REGRA
-- ----------------------------------------------------------------------------
--   numerador = honorário dos dias úteis FECHADOS (1º do mês até ONTEM)
--   divisor   = quantidade desses mesmos dias úteis fechados
--   projeção  = numerador / divisor * dias úteis totais do mês
--
--   Numerador e divisor cobrem EXATAMENTE o mesmo período, encerrado até
--   ontem, em horário de Brasília. Sem piso artificial.
--
--   O honorário recebido HOJE continua no realizado e nos cartões de "hoje",
--   mas NÃO entra na projeção até o dia fechar.
--
--   Sem nenhum dia fechado (1º dia útil do mês), não existe projeção: o campo
--   vai NULO e a tela mostra "Aguardando fechamento do primeiro dia útil".
--
--   04/11/2026, com o dia 3 fechado em 5.354,85 e 19 dias úteis no mês:
--     5.354,85 / 1 * 19 = R$ 101.742,15   (valor esperado pela gestão)
--
--   Como o numerador não tem o dinheiro de hoje, a projeção fica ESTÁVEL ao
--   longo do dia e muda uma vez por dia, no fechamento. Não infla nem recua.
--
-- ----------------------------------------------------------------------------
-- ESTADO DE PRODUÇÃO QUE ESTE SCRIPT ESPERA
-- ----------------------------------------------------------------------------
-- O patch de 2026-11-03 **já está aplicado em produção** (conferido em
-- 04/11/2026): as três funções têm o bloco `REGRA 2026-11-03`, `v_hoje` em data
-- local e um campo `projecao_parcial` no payload. O snapshot de 2026-11 foi
-- regerado pela Amanda em 04/11 às 08:11.
--
-- Este script é o SEGUNDO patch, ancorado nesse estado. Há uma GUARDA DE
-- PRÉ-CONDIÇÃO no início: se o patch de 2026-11-03 não estiver aplicado, aborta
-- sem tocar em nada.
--
-- ----------------------------------------------------------------------------
-- HISTÓRICO DA FÓRMULA (para quem ler isso depois)
-- ----------------------------------------------------------------------------
--   premissa 2026-08-17 : base = dias_uteis(ini, hoje) - 1, piso 0
--                         numerador = honorário do mês inteiro (inclui hoje)
--                         -> 1º dia útil zerava a projeção
--   patch 1   2026-11-03: base = dias_uteis(ini, hoje)   (hoje contava)
--                         -> projeção caía pela metade na virada do dia
--   patch 2   2026-11-04: base = dias_uteis(ini, hoje - 1), SEM piso
--                         numerador = honorário só dos dias fechados
--                         -> este script
--
-- `dias_uteis(ini, hoje - 1)` não é o `- 1` de agosto: aquele descontava um dia
-- que JÁ tinha fechado em sábado, domingo e feriado (em 14/11 daria 8 em vez
-- de 9). Contar até ontem acerta esses dias.
--
-- ----------------------------------------------------------------------------
-- O QUE NÃO MUDA (indicadores financeiros preservados)
-- ----------------------------------------------------------------------------
--   · realizado, recuperado e honorário do mês (`v_hon_mes` segue intacto) e os
--     cartões de hoje — nenhuma linha de pagamento é lida de forma diferente;
--   · metas (metas_projecao), faixas, percentuais e comissão — `v_du_pass` só é
--     usado na projeção e no payload, em nenhum outro cálculo;
--   · "dias úteis restantes" (conta hoje, que ainda vai fechar) e portanto
--     "média diária necessária" e "necessário por dia útil";
--   · `v_hoje` em data local e os grants — vieram no patch 1;
--   · mês encerrado: `least(v_hoje - 1, v_fim) = v_fim`, a base é o total e a
--     projeção é o realizado. Outubro/2026 segue 21/21.
--
-- NOTA sobre a TV: `media_diaria` e `media_diaria_honorarios` continuam com a
-- fórmula que já tinham (mês corrente ÷ v_du_ate). Como v_du_ate volta a ser o
-- dia fechado, elas voltam ao valor que tinham ANTES do patch 1 — restauração,
-- não mudança nova. Nenhuma fórmula de indicador foi reescrita.
--
-- NOTA sobre `_tv_meta_obj`: com a projeção nula no 1º dia útil, o campo
-- `situacao` das metas da TV cai no ramo final e diz "Abaixo do ritmo". É o
-- mesmo texto que ele já mostra no começo do mês hoje, então não é regressão —
-- mas fica anotado, porque corrigir isso é mexer em outra função.
--
-- ----------------------------------------------------------------------------
-- CAMPO NOVO NO PAYLOAD
-- ----------------------------------------------------------------------------
--   `projecao_aguardando_fechamento` (boolean) substitui `projecao_parcial`,
--   que deixou de fazer sentido: a projeção não é mais parcial, porque não
--   contém o dia em andamento. É true quando não há nenhum dia útil fechado no
--   mês, e é o que faz a tela escrever "Aguardando fechamento do primeiro dia
--   útil" em vez de um número.
--
-- ----------------------------------------------------------------------------
-- COMO O PATCH É FEITO
-- ----------------------------------------------------------------------------
-- Patch ANCORADO sobre pg_get_functiondef, não reescrita das funções: o corpo
-- em produção não é o do repositório. Cada substituição é conferida e qualquer
-- âncora que não casar aborta tudo.
--
-- O honorário do período fechado é lido por uma consulta própria, no mesmo
-- universo de linhas que o honorário do mês de cada função (a filial soma
-- tudo; o operador filtra pelo e-mail / SEM_OPERADOR). Isso evita cirurgia
-- dentro das CTEs e do `select ... into`.
--
-- CREATE OR REPLACE RESTAURA OS GRANTS PADRÃO (execute para PUBLIC). Os grants
-- são reaplicados no fim, iguais aos conferidos em produção em 04/11/2026.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- PRÉ-CONDIÇÃO: o patch de 2026-11-03 tem de estar aplicado.
-- ----------------------------------------------------------------------------
do $guarda$
declare v_faltam text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into v_faltam
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('projecao_calcular_filial','projecao_calcular_operador','tv_snapshot_calcular')
    and strpos(pg_get_functiondef(p.oid), 'REGRA 2026-11-03') = 0;

  if v_faltam is not null then
    raise exception
      'PRE-CONDICAO NAO ATENDIDA: o patch de 2026-11-03 nao esta aplicado em: %. Este script e o PATCH 2 e so roda sobre aquele estado.',
      v_faltam;
  end if;
end
$guarda$;

do $patch$
declare
  v_def  text;
  v_novo text;
  v_cab  text;   -- comentário comum às duas funções do CRM
begin

  v_cab :=
       '  -- REGRA 2026-11-04 (gestao): projecao SO por dia util FECHADO.'       || E'\n'
    || '  -- Numerador e divisor cobrem exatamente o MESMO periodo: 1o do mes'   || E'\n'
    || '  -- ate ONTEM, em horario de Brasilia. O honorario de hoje segue no'    || E'\n'
    || '  -- realizado, mas nao entra na projecao antes do dia fechar -- por'    || E'\n'
    || '  -- isso a projecao fica estavel no dia e muda uma vez, no fechamento.' || E'\n'
    || '  -- Sem nenhum dia fechado (1o dia util do mes) NAO existe projecao: o' || E'\n'
    || '  -- campo vai nulo e a tela diz "Aguardando fechamento do primeiro dia' || E'\n'
    || '  -- util" (projecao_aguardando_fechamento).'                            || E'\n'
    || '  -- Mes encerrado: least(v_hoje - 1, v_fim) = v_fim, base = total.'     || E'\n';

  -- ==========================================================================
  -- 1) projecao_calcular_filial
  -- ==========================================================================
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'projecao_calcular_filial';
  if v_def is null then raise exception 'projecao_calcular_filial nao encontrada'; end if;
  v_novo := v_def;

  -- 1.a declaração: v_parcial sai, entram v_aguardando e v_hon_fec
  if strpos(v_novo, 'v_du_rest int; v_du_pass int; v_du_total int; v_parcial boolean;') = 0 then
    raise exception 'ANCORA 1.a (declare) nao casou em projecao_calcular_filial';
  end if;
  v_novo := replace(v_novo,
    'v_du_rest int; v_du_pass int; v_du_total int; v_parcial boolean;',
    'v_du_rest int; v_du_pass int; v_du_total int; v_aguardando boolean; v_hon_fec numeric;');

  -- 1.b a base passa a contar até ONTEM
  if strpos(v_novo, 'v_du_pass  := public.dias_uteis(v_ini, least(v_hoje, v_fim));') = 0 then
    raise exception 'ANCORA 1.b (base) nao casou em projecao_calcular_filial';
  end if;
  v_novo := replace(v_novo,
    'v_du_pass  := public.dias_uteis(v_ini, least(v_hoje, v_fim));',
    'v_du_pass  := public.dias_uteis(v_ini, least(v_hoje - 1, v_fim));');

  -- 1.c bloco do patch 1 -> comentário novo + honorário do período fechado
  v_def := v_novo;
  v_novo := regexp_replace(v_novo,
    '[ \t]*--[^\n]*REGRA 2026-11-03[^\n]*\n([ \t]*--[^\n]*\n)*[ \t]*v_parcial := \(v_hoje between v_ini and v_fim\)[^\n]*\n',
    v_cab
    || '  select coalesce(sum(valor_honorario),0) into v_hon_fec'                || E'\n'
    || '  from public.pagamentos'                                               || E'\n'
    || '  where data_pagamento >= v_ini and data_pagamento <= least(v_hoje - 1, v_fim);' || E'\n'
    || '  v_aguardando := (v_du_pass = 0);'                                     || E'\n');
  if v_novo = v_def then
    raise exception 'ANCORA 1.c (bloco do patch 1) nao casou em projecao_calcular_filial';
  end if;

  -- 1.d a projeção passa a usar o honorário fechado, e fica nula sem base
  if strpos(v_novo, '  v_proj_filial := case when v_du_pass > 0 then round((v_hon_mes / v_du_pass) * v_du_total, 2) else v_hon_mes end;') = 0 then
    raise exception 'ANCORA 1.d (projecao) nao casou em projecao_calcular_filial';
  end if;
  v_novo := replace(v_novo,
    '  v_proj_filial := case when v_du_pass > 0 then round((v_hon_mes / v_du_pass) * v_du_total, 2) else v_hon_mes end;',
    '  v_proj_filial := case when v_du_pass > 0 then round((v_hon_fec / v_du_pass) * v_du_total, 2) else null end;');

  -- 1.e payload
  if strpos(v_novo, '''projecao_parcial'', v_parcial,') = 0 then
    raise exception 'ANCORA 1.e (payload) nao casou em projecao_calcular_filial';
  end if;
  v_novo := replace(v_novo,
    '''projecao_parcial'', v_parcial,',
    '''projecao_aguardando_fechamento'', v_aguardando,');

  if strpos(v_novo, 'v_parcial') > 0
     or strpos(v_novo, 'REGRA 2026-11-03') > 0
     or strpos(v_novo, 'v_du_pass - 1') > 0 then
    raise exception 'GUARDA: resto do patch 1 ou de agosto sobrou em projecao_calcular_filial';
  end if;
  execute v_novo;
  raise notice 'patch 2 aplicado: projecao_calcular_filial(text)';

  -- ==========================================================================
  -- 2) projecao_calcular_operador
  -- ==========================================================================
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'projecao_calcular_operador';
  if v_def is null then raise exception 'projecao_calcular_operador nao encontrada'; end if;
  v_novo := v_def;

  if strpos(v_novo, 'v_du_rest int; v_du_pass int; v_du_total int; v_parcial boolean;') = 0 then
    raise exception 'ANCORA 2.a (declare) nao casou em projecao_calcular_operador';
  end if;
  v_novo := replace(v_novo,
    'v_du_rest int; v_du_pass int; v_du_total int; v_parcial boolean;',
    'v_du_rest int; v_du_pass int; v_du_total int; v_aguardando boolean; v_hon_fec numeric;');

  if strpos(v_novo, 'v_du_pass  := public.dias_uteis(v_ini, least(v_hoje, v_fim));') = 0 then
    raise exception 'ANCORA 2.b (base) nao casou em projecao_calcular_operador';
  end if;
  v_novo := replace(v_novo,
    'v_du_pass  := public.dias_uteis(v_ini, least(v_hoje, v_fim));',
    'v_du_pass  := public.dias_uteis(v_ini, least(v_hoje - 1, v_fim));');

  -- Mesmo universo de linhas do `op` desta função: e-mail do operador, ou
  -- operador_email nulo quando p_email = 'SEM_OPERADOR'.
  v_def := v_novo;
  v_novo := regexp_replace(v_novo,
    '[ \t]*--[^\n]*REGRA 2026-11-03[^\n]*\n([ \t]*--[^\n]*\n)*[ \t]*v_parcial := \(v_hoje between v_ini and v_fim\)[^\n]*\n',
    v_cab
    || '  select coalesce(sum(valor_honorario),0) into v_hon_fec'                || E'\n'
    || '  from public.pagamentos'                                               || E'\n'
    || '  where data_pagamento >= v_ini and data_pagamento <= least(v_hoje - 1, v_fim)' || E'\n'
    || '    and ( (v_sem and operador_email is null)'                           || E'\n'
    || '          or (not v_sem and lower(operador_email) = p_email) );'        || E'\n'
    || '  v_aguardando := (v_du_pass = 0);'                                     || E'\n');
  if v_novo = v_def then
    raise exception 'ANCORA 2.c (bloco do patch 1) nao casou em projecao_calcular_operador';
  end if;

  if strpos(v_novo, '    v_proj_ind := case when v_du_pass > 0 then round((v_hon_mes / v_du_pass) * v_du_total, 2) else v_hon_mes end;') = 0 then
    raise exception 'ANCORA 2.d (projecao) nao casou em projecao_calcular_operador';
  end if;
  v_novo := replace(v_novo,
    '    v_proj_ind := case when v_du_pass > 0 then round((v_hon_mes / v_du_pass) * v_du_total, 2) else v_hon_mes end;',
    '    v_proj_ind := case when v_du_pass > 0 then round((v_hon_fec / v_du_pass) * v_du_total, 2) else null end;');

  if strpos(v_novo, '''projecao_parcial'', v_parcial,') = 0 then
    raise exception 'ANCORA 2.e (payload) nao casou em projecao_calcular_operador';
  end if;
  v_novo := replace(v_novo,
    '''projecao_parcial'', v_parcial,',
    '''projecao_aguardando_fechamento'', v_aguardando,');

  if strpos(v_novo, 'v_parcial') > 0
     or strpos(v_novo, 'REGRA 2026-11-03') > 0
     or strpos(v_novo, 'v_du_pass - 1') > 0 then
    raise exception 'GUARDA: resto do patch 1 ou de agosto sobrou em projecao_calcular_operador';
  end if;
  execute v_novo;
  raise notice 'patch 2 aplicado: projecao_calcular_operador(text,text)';

  -- ==========================================================================
  -- 3) tv_snapshot_calcular
  -- ==========================================================================
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular';
  if v_def is null then raise exception 'tv_snapshot_calcular nao encontrada'; end if;
  v_novo := v_def;

  -- 3.a declaração
  if strpos(v_novo, 'v_du_mes int; v_du_ate int; v_du_rest int; v_parcial boolean;') = 0 then
    raise exception 'ANCORA 3.a (declare) nao casou na TV';
  end if;
  v_novo := replace(v_novo,
    'v_du_mes int; v_du_ate int; v_du_rest int; v_parcial boolean;',
    'v_du_mes int; v_du_ate int; v_du_rest int; v_aguardando boolean; v_rec_fec bigint; v_hon_fec bigint;');

  -- 3.b v_du_ate passa a contar até ONTEM
  if strpos(v_novo, 'least(current_date, (date_trunc(''month'',current_date) + interval ''1 month - 1 day'')::date)') = 0 then
    raise exception 'ANCORA 3.b (v_du_ate) nao casou na TV';
  end if;
  v_novo := replace(v_novo,
    'least(current_date, (date_trunc(''month'',current_date) + interval ''1 month - 1 day'')::date)',
    'least(current_date - 1, (date_trunc(''month'',current_date) + interval ''1 month - 1 day'')::date)');

  -- 3.c bloco do patch 1 -> recuperado e honorário do período fechado.
  --     v_du_rest não muda: segue contando hoje, pela fórmula do CRM.
  v_def := v_novo;
  v_novo := regexp_replace(v_novo,
    '[ \t]*--[^\n]*REGRA 2026-11-03[^\n]*\n([ \t]*--[^\n]*\n)*[ \t]*v_du_rest := public\.dias_uteis\(current_date[^\n]*\n[ \t]*v_parcial := public\.dias_uteis\(current_date, current_date\) = 1;[ \t]*\n',
       '  -- REGRA 2026-11-04 (gestao): projecao SO por dia util FECHADO -- o'   || E'\n'
    || '  -- numerador (v_rec_fec / v_hon_fec) e o divisor (v_du_ate) cobrem o'  || E'\n'
    || '  -- mesmo periodo: 1o do mes ate ONTEM. O dinheiro de hoje segue no'    || E'\n'
    || '  -- realizado, fora da projecao. Sem dia fechado a projecao e nula.'    || E'\n'
    || '  -- "Restantes" conta hoje -- o dia ainda vai fechar -- pela mesma'     || E'\n'
    || '  -- formula do CRM, para TV e CRM nao divergirem.'                      || E'\n'
    || '  v_du_rest := public.dias_uteis(current_date, (date_trunc(''month'',current_date) + interval ''1 month - 1 day'')::date);' || E'\n'
    || '  select coalesce(round(sum(valor_pago)),0)::bigint, coalesce(round(sum(valor_honorario)),0)::bigint' || E'\n'
    || '    into v_rec_fec, v_hon_fec'                                          || E'\n'
    || '  from public.pagamentos where data_pagamento is not null'              || E'\n'
    || '    and date_trunc(''month'',data_pagamento) = date_trunc(''month'',current_date)' || E'\n'
    || '    and data_pagamento <= current_date - 1;'                            || E'\n'
    || '  v_aguardando := (v_du_ate = 0);'                                      || E'\n');
  if v_novo = v_def then
    raise exception 'ANCORA 3.c (bloco do patch 1) nao casou na TV';
  end if;

  -- 3.d as duas projeções do bloco de ritmo
  if strpos(v_novo, '  v_proj_rec := case when v_du_ate > 0 then round(v_rec::numeric / v_du_ate * v_du_mes) else v_rec end;') = 0
     or strpos(v_novo, '  v_proj_hon := case when v_du_ate > 0 then round(v_hon::numeric / v_du_ate * v_du_mes) else v_hon end;') = 0 then
    raise exception 'ANCORA 3.d (proj_rec/proj_hon) nao casou na TV';
  end if;
  v_novo := replace(v_novo,
    '  v_proj_rec := case when v_du_ate > 0 then round(v_rec::numeric / v_du_ate * v_du_mes) else v_rec end;',
    '  v_proj_rec := case when v_du_ate > 0 then round(v_rec_fec::numeric / v_du_ate * v_du_mes) else null end;');
  v_novo := replace(v_novo,
    '  v_proj_hon := case when v_du_ate > 0 then round(v_hon::numeric / v_du_ate * v_du_mes) else v_hon end;',
    '  v_proj_hon := case when v_du_ate > 0 then round(v_hon_fec::numeric / v_du_ate * v_du_mes) else null end;');

  -- 3.e projecao_fechamento (recuperado) é a mesma projeção: período fechado.
  --     `media_diaria` fica como está — indicador existente, fórmula intacta.
  if strpos(v_novo, '  v_proj_fech := case when v_du_ate > 0 then round(v_media_dia * v_du_mes) else v_rec end;') = 0 then
    raise exception 'ANCORA 3.e (proj_fech) nao casou na TV';
  end if;
  v_novo := replace(v_novo,
    '  v_proj_fech := case when v_du_ate > 0 then round(v_media_dia * v_du_mes) else v_rec end;',
    '  v_proj_fech := case when v_du_ate > 0 then round(v_rec_fec::numeric / v_du_ate * v_du_mes) else null end;');

  -- 3.f payload (duas ocorrências)
  if strpos(v_novo, '''projecao_parcial'', v_parcial,') = 0 then
    raise exception 'ANCORA 3.f (payload) nao casou na TV';
  end if;
  v_novo := replace(v_novo,
    '''projecao_parcial'', v_parcial,',
    '''projecao_aguardando_fechamento'', v_aguardando,');

  if strpos(v_novo, 'v_parcial') > 0
     or strpos(v_novo, 'REGRA 2026-11-03') > 0
     or strpos(v_novo, 'v_du_ate - 1') > 0 then
    raise exception 'GUARDA: resto do patch 1 ou de agosto sobrou na TV';
  end if;
  if strpos(v_novo, 'v_media_dia := case when v_du_ate > 0 then round(v_rec::numeric / v_du_ate) else 0 end;') = 0 then
    raise exception 'GUARDA: media_diaria da TV foi alterada -- nao deveria';
  end if;
  execute v_novo;
  raise notice 'patch 2 aplicado: tv_snapshot_calcular()';
end
$patch$;

-- ============================================================================
-- GRANTS — CREATE OR REPLACE devolveu execute para PUBLIC. Reposto como estava.
-- ============================================================================
revoke all on function public.projecao_calcular_filial(text)        from public, anon, authenticated;
revoke all on function public.projecao_calcular_operador(text,text) from public, anon, authenticated;
grant execute on function public.projecao_calcular_filial(text)        to service_role;
grant execute on function public.projecao_calcular_operador(text,text) to service_role;

revoke all on function public.tv_snapshot_calcular() from public, anon;
grant execute on function public.tv_snapshot_calcular() to authenticated, service_role;

-- ============================================================================
-- CONFERÊNCIA (ainda dentro da transação; nada é gravado por estas linhas)
-- ============================================================================
select p.proname,
       coalesce(array_to_string(p.proacl, ' | '), '(default)') as acl_final,
       strpos(pg_get_functiondef(p.oid), 'REGRA 2026-11-04') > 0 as regra_nova,
       strpos(pg_get_functiondef(p.oid), 'REGRA 2026-11-03') > 0 as sobrou_patch1,
       strpos(pg_get_functiondef(p.oid), 'projecao_aguardando_fechamento') > 0 as tem_campo_novo,
       strpos(pg_get_functiondef(p.oid), 'v_parcial') > 0 as sobrou_parcial
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('projecao_calcular_filial','projecao_calcular_operador','tv_snapshot_calcular')
order by p.proname;

-- ESPERADO: regra_nova = t · sobrou_patch1 = f · tem_campo_novo = t · sobrou_parcial = f
--   projecao_calcular_filial    postgres=X/postgres | service_role=X/postgres
--   projecao_calcular_operador  postgres=X/postgres | service_role=X/postgres
--   tv_snapshot_calcular        postgres=X/postgres | service_role=X/postgres | authenticated=X/postgres

commit;

-- ============================================================================
-- DEPOIS DO COMMIT — regerar os snapshots (as funções acima só calculam):
--   · CRM: botão "Atualizar projeção" na tela
--   · TV:  select public.tv_snapshot_atualizar();  -- ou o cron 85 (*/15 11-23 * * 1-5)
--
-- CONFERÊNCIA DE VALOR, novembro/2026 (19 dias úteis):
--   select payload->>'dias_uteis_passados'       as base_fechada,
--          payload->>'dias_uteis_total_mes'      as total,
--          payload->>'honorario_mes'             as realizado,
--          payload->>'projecao_honorario_filial' as projecao,
--          payload->>'projecao_aguardando_fechamento' as aguardando
--   from public.projecao_snapshot
--   where escopo = 'FILIAL' and mes_referencia = '2026-11';
--
--   em 04/11: base_fechada 1 · total 19 · aguardando false
--             projecao 101742.15  (5.354,85 do dia 3 × 19)
--   o realizado segue subindo durante o dia; a PROJEÇÃO não se move até
--   o fechamento — é assim que se confere que a regra está certa.
-- ============================================================================
