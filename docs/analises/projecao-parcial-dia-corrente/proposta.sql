-- ============================================================================
-- PATCH 2 — A BASE DO RITMO VOLTA A SER SEMPRE O DIA FECHADO (piso de 1)
-- Decisão da gestão em 04/11/2026.
--
-- NÃO APLICADO. Proposta para a Amanda aplicar (R5/P3 do Guardião: nesta fase
-- nenhum agente escreve migration; o caminho autorizado é propor o SQL).
--
-- ----------------------------------------------------------------------------
-- ESTADO DE PRODUÇÃO QUE ESTE SCRIPT ESPERA
-- ----------------------------------------------------------------------------
-- O patch de 2026-11-03 **já está aplicado em produção** (conferido em
-- 04/11/2026): as três funções têm o bloco `REGRA 2026-11-03`, o campo
-- `projecao_parcial` no payload e `v_hoje` em data local. O snapshot de 2026-11
-- foi regerado pela Amanda em 04/11 às 08:11 e é o que está na tela.
--
-- Por isso este script é um SEGUNDO patch, ancorado nesse estado — não é o
-- primeiro de novo. Há uma GUARDA DE PRÉ-CONDIÇÃO no início: se o patch de
-- 2026-11-03 não estiver aplicado, aborta sem tocar em nada.
--
-- ----------------------------------------------------------------------------
-- O QUE MUDA
-- ----------------------------------------------------------------------------
-- O patch 1 colocou o DIA CORRENTE na base do ritmo. Na prática isso fez a
-- projeção cair pela metade na virada da meia-noite: em 04/11, com só o dia 3
-- fechado, a base virou 2 e a projeção caiu de ~102 mil para 51.028,40 sem que
-- nada tivesse acontecido.
--
-- A gestão corrigiu: "hoje não é o 2 e sim o 1 dia de projeção". A base volta a
-- ser o DIA FECHADO — que é a premissa de 2026-08-17, e por um motivo real:
-- boleto e parte dos cartões caem em D+1, então o dia corrente está incompleto
-- e não pode virar divisor. O que entra de novo é o PISO DE 1, para a projeção
-- existir já no 1º dia útil em vez de repetir o realizado.
--
--   base     = dias úteis FECHADOS (1º do mês até ONTEM), com piso de 1
--   projeção = honorário acumulado / base * dias úteis totais do mês
--
--   03/11 (1º dia útil): nenhum dia fechado -> piso 1 -> 4.073,80 × 19 = 77.402,20
--   04/11 (2º dia útil): fechou só o dia 3  -> base 1 -> 5.371,41 × 19 = 102.056,79
--   05/11 (3º dia útil): fecharam 3 e 4     -> base 2
--
-- O piso de 1 é o que separa esta regra da premissa de agosto: lá a base era
-- `greatest(fechados, 0)`, que no 1º dia útil dava 0 e derrubava a projeção
-- para o realizado. Aqui o mínimo é 1.
--
-- Diferença de fórmula em relação ao patch 1, nas três funções:
--   antes (agosto):  base = dias_uteis(ini, hoje) - 1, piso 0
--   patch 1 (03/11): base = dias_uteis(ini, hoje)              <- hoje contava
--   patch 2 (04/11): base = dias_uteis(ini, hoje - 1), piso 1  <- este script
--
-- Note que `dias_uteis(ini, hoje - 1)` não é o mesmo que o `- 1` de agosto: em
-- sábado, domingo e feriado o desconto de agosto tirava um dia que já tinha
-- fechado (em 14/11 daria 8 em vez de 9). Contar até ontem acerta isso.
--
-- ----------------------------------------------------------------------------
-- O QUE NÃO MUDA
-- ----------------------------------------------------------------------------
--   · valor realizado, recuperado, honorário — nenhuma linha de pagamento é
--     lida de forma diferente;
--   · metas (metas_projecao) e faixas/percentuais de comissão;
--   · `projecao_parcial`, o campo e a regra dele: segue true enquanto hoje for
--     dia útil dentro do mês. E segue correto — o honorário de hoje está no
--     numerador, então o número ainda vai mexer;
--   · "dias úteis restantes" (conta hoje, que ainda vai fechar), e portanto
--     "média diária necessária" e "necessário por dia útil";
--   · mês encerrado: `v_hoje <= v_fim` é falso, a base continua sendo o total e
--     a projeção continua igual ao realizado. Outubro/2026 segue 21/21;
--   · `v_hoje` em data local, o payload e os grants — tudo isso veio no patch 1
--     e este script não mexe.
--
-- EFEITO A CONHECER: o honorário de hoje entra no numerador sobre um divisor
-- que não conta hoje. Cada R$ 1 que entra hoje vale R$ 19 de projeção, então a
-- projeção sobe ao longo do dia e recua na virada, quando o divisor ganha +1.
-- É o preço de a projeção existir no 1º dia útil E refletir o dinheiro de hoje,
-- que foram os dois pedidos da gestão.
--
-- ----------------------------------------------------------------------------
-- COMO O PATCH É FEITO
-- ----------------------------------------------------------------------------
-- Patch ANCORADO sobre pg_get_functiondef, não reescrita das funções: o corpo
-- em produção não é o do repositório. Uma única substituição por função, no
-- bloco `REGRA 2026-11-03`. Qualquer âncora que não casar aborta tudo.
--
-- CREATE OR REPLACE RESTAURA OS GRANTS PADRÃO (execute para PUBLIC). Os grants
-- são reaplicados no fim, iguais aos conferidos em produção em 04/11/2026:
--   projecao_calcular_filial   -> postgres + service_role
--   projecao_calcular_operador -> postgres + service_role
--   tv_snapshot_calcular       -> postgres + service_role + authenticated
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
  v_rec   record;
  v_def   text;
  v_novo  text;
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

    -- Âncora: o bloco do patch 1 (comentário REGRA 2026-11-03 + a atribuição
    -- de v_parcial). Entra o cálculo da base pelo dia fechado, com piso de 1.
    v_novo := regexp_replace(
      v_def,
      '[ \t]*--[^\n]*REGRA 2026-11-03[^\n]*\n([ \t]*--[^\n]*\n)*[ \t]*v_parcial := \(v_hoje between v_ini and v_fim\)[^\n]*\n',
         '  -- REGRA 2026-11-04 (gestao): a base do ritmo e sempre o DIA FECHADO.'   || E'\n'
      || '  -- O dia corrente esta incompleto -- boleto e parte dos cartoes caem em' || E'\n'
      || '  -- D+1 -- e nao vira divisor: em 04/11 a base e 1 (so o dia 3 fechou),'  || E'\n'
      || '  -- nao 2. Dividir por 2 na virada da meia-noite cortaria a projecao'     || E'\n'
      || '  -- pela metade sem que nada tivesse acontecido.'                         || E'\n'
      || '  -- PISO DE 1: no 1o dia util do mes nada fechou ainda, e o piso faz a'   || E'\n'
      || '  -- projecao existir desde o primeiro dia em vez de repetir o realizado.' || E'\n'
      || '  -- Contar ate ONTEM, e nao "transcorridos - 1", acerta sabado, domingo'  || E'\n'
      || '  -- e feriado, em que o dia anterior ja estava fechado.'                  || E'\n'
      || '  -- Mes encerrado: v_hoje > v_fim, a base segue sendo o total.'           || E'\n'
      || '  if v_hoje <= v_fim then'                                                 || E'\n'
      || '    v_du_pass := greatest(public.dias_uteis(v_ini, v_hoje - 1), 1);'       || E'\n'
      || '  end if;'                                                                 || E'\n'
      || '  v_parcial := (v_hoje between v_ini and v_fim) and public.dias_uteis(v_hoje, v_hoje) = 1;' || E'\n'
    );
    if v_novo = v_def then
      raise exception 'ANCORA 1 nao casou em %', v_rec.assinatura;
    end if;

    -- guardas: a base nova entrou, o bloco antigo saiu, o resto ficou de pe.
    if strpos(v_novo, 'v_du_pass := greatest(public.dias_uteis(v_ini, v_hoje - 1), 1);') = 0 then
      raise exception 'GUARDA: base por dia fechado nao entrou em %', v_rec.assinatura;
    end if;
    if strpos(v_novo, 'REGRA 2026-11-03') > 0 then
      raise exception 'GUARDA: bloco do patch 1 sobrou em %', v_rec.assinatura;
    end if;
    if strpos(v_novo, 'v_du_pass - 1') > 0 then
      raise exception 'GUARDA: desconto de agosto reapareceu em %', v_rec.assinatura;
    end if;
    if strpos(v_novo, '(v_hon_mes / v_du_pass) * v_du_total') = 0
       or strpos(v_novo, '''projecao_parcial'', v_parcial,') = 0
       or strpos(v_novo, '(now() at time zone ''America/Sao_Paulo'')::date') = 0 then
      raise exception 'GUARDA: conta, payload ou dia local inesperados em %', v_rec.assinatura;
    end if;

    execute v_novo;
    raise notice 'patch 2 aplicado: %', v_rec.assinatura;
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

  -- Na TV, v_du_ate é calculado logo acima com `least(current_date, fim)` — ou
  -- seja, inclui hoje. Aqui ele é recalculado pelo dia fechado, com piso de 1.
  -- v_du_rest não muda: segue contando hoje, pela mesma fórmula do CRM.
  v_novo := regexp_replace(
    v_def,
    '[ \t]*--[^\n]*REGRA 2026-11-03[^\n]*\n([ \t]*--[^\n]*\n)*[ \t]*v_du_rest := public\.dias_uteis\(current_date[^\n]*\n[ \t]*v_parcial := public\.dias_uteis\(current_date, current_date\) = 1;[ \t]*\n',
       '  -- REGRA 2026-11-04 (gestao): a base do ritmo e sempre o DIA FECHADO,'  || E'\n'
    || '  -- com PISO DE 1 no 1o dia util do mes. O dia corrente esta incompleto' || E'\n'
    || '  -- (boleto e parte dos cartoes em D+1) e nao vira divisor.'             || E'\n'
    || '  -- "Restantes" conta hoje -- o dia ainda vai fechar -- pela mesma'      || E'\n'
    || '  -- formula do CRM, para TV e CRM nao divergirem.'                       || E'\n'
    || '  v_du_ate := greatest(public.dias_uteis(date_trunc(''month'',current_date)::date, current_date - 1), 1);' || E'\n'
    || '  v_du_rest := public.dias_uteis(current_date, (date_trunc(''month'',current_date) + interval ''1 month - 1 day'')::date);' || E'\n'
    || '  v_parcial := public.dias_uteis(current_date, current_date) = 1;'        || E'\n'
  );
  if v_novo = v_def then
    raise exception 'ANCORA 2 nao casou';
  end if;

  if strpos(v_novo, 'v_du_ate := greatest(public.dias_uteis(date_trunc(''month'',current_date)::date, current_date - 1), 1);') = 0 then
    raise exception 'GUARDA: base por dia fechado nao entrou na TV';
  end if;
  if strpos(v_novo, 'REGRA 2026-11-03') > 0 then
    raise exception 'GUARDA: bloco do patch 1 sobrou na TV';
  end if;
  if strpos(v_novo, 'v_du_ate - 1') > 0 then
    raise exception 'GUARDA: desconto de agosto reapareceu na TV';
  end if;
  if strpos(v_novo, 'v_hon::numeric / v_du_ate * v_du_mes') = 0
     or strpos(v_novo, '''projecao_parcial'', v_parcial,') = 0 then
    raise exception 'GUARDA: conta ou payload inesperados na TV';
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
       strpos(pg_get_functiondef(p.oid), 'REGRA 2026-11-04')  > 0 as regra_nova,
       strpos(pg_get_functiondef(p.oid), 'REGRA 2026-11-03')  > 0 as sobrou_patch1,
       strpos(pg_get_functiondef(p.oid), 'projecao_parcial')  > 0 as tem_flag,
       (strpos(pg_get_functiondef(p.oid), 'v_du_pass - 1') > 0
        or strpos(pg_get_functiondef(p.oid), 'v_du_ate - 1') > 0) as desconto_de_agosto
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('projecao_calcular_filial','projecao_calcular_operador','tv_snapshot_calcular')
order by p.proname;

-- ESPERADO: regra_nova = t · sobrou_patch1 = f · tem_flag = t · desconto_de_agosto = f
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
--   select payload->>'dias_uteis_passados'       as base,
--          payload->>'dias_uteis_total_mes'      as total,
--          payload->>'honorario_mes'             as realizado,
--          payload->>'projecao_honorario_filial' as projecao,
--          payload->>'projecao_parcial'          as parcial
--   from public.projecao_snapshot
--   where escopo = 'FILIAL' and mes_referencia = '2026-11';
--
--   em 04/11: base 1 (só o dia 3 fechou) · total 19 · parcial true
--             projecao = realizado × 19
--   a partir de 05/11: base 2, e a razão projecao/realizado cai para 9,5
-- ============================================================================
