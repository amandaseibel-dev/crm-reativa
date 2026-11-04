-- ============================================================================
-- PROJEÇÃO PARCIAL DESDE O 1º DIA ÚTIL  ·  regra definida pela gestão 03/11/2026
--
-- NÃO APLICADO. Proposta para a Amanda aplicar (R5/P3 do Guardião: nesta fase
-- nenhum agente escreve migration; o caminho autorizado é propor o SQL).
--
-- O QUE MUDA (uma única regra, em três funções):
--   o DIA CORRENTE passa a entrar na base do ritmo. Hoje ele é descontado
--   (premissa de 2026-08-17, "só dia fechado entra"), e por isso no 1º dia útil
--   do mês a base é 0 e a projeção repete o realizado.
--
--   base     = dias úteis de 1º do mês até hoje (hoje INCLUSO)
--   projeção = honorário acumulado / base * dias úteis totais do mês
--
--   03/11/2026: 4.073,80 / 1 * 19 = 77.402,20   (exemplo conferido pela gestão)
--
-- O QUE NÃO MUDA:
--   · valor realizado, recuperado, honorário — nenhuma linha de pagamento é
--     lida de forma diferente;
--   · metas (metas_projecao) e faixas/percentuais de comissão;
--   · "dias úteis restantes" continua contando HOJE (o dia ainda vai fechar),
--     então "média diária necessária" e "necessário por dia útil" não se movem;
--   · mês já encerrado: o `if v_hoje <= v_fim` já era falso, logo snapshot de
--     mês fechado continua idêntico (outubro/2026 segue 21/21 e projeção =
--     realizado). Nenhum fechamento histórico é reescrito.
--
-- O QUE ENTRA DE NOVO NO PAYLOAD:
--   `projecao_parcial` (boolean) — true enquanto o dia corrente estiver na base,
--   isto é: hoje está dentro do mês de referência E hoje é dia útil. É o que o
--   CRM e a TV usam para escrever PROJEÇÃO PARCIAL na tela. A conta continua só
--   no banco: nenhuma tela recalcula projeção (nada duplicado CRM × TV).
--
-- DIA CORRENTE É DIA LOCAL (America/Sao_Paulo):
--   `projecao_calcular_filial/operador` usavam `current_date`, que no banco é
--   UTC. Às 21h locais o UTC já virou, e a base ganharia um dia útil sem
--   honorário nenhum — às 21h de 03/11 a projeção cairia de 77.402,20 para
--   38.701,10. Com o dia corrente DENTRO da base isso deixa de ser detalhe, por
--   isso v_hoje passa a ser a data local. Efeito colateral bem-vindo: os cartões
--   "hoje" (recuperado/honorário/pagamentos) param de trocar de dia às 21h.
--   tv_snapshot_calcular segue com current_date no bloco de dias úteis: o cron
--   da TV roda 11–23 UTC (8h–20h local) e nunca cruza a virada. Fica anotado
--   como pendência própria, fora do escopo desta correção.
--
-- COMO O PATCH É FEITO:
--   patch ANCORADO sobre pg_get_functiondef, não reescrita das funções. O corpo
--   em produção não é o do repositório (o helper public.dias_uteis entrou em
--   2026-09-03 por patch), então reescrever à mão perderia código vivo.
--   Cada substituição é conferida; qualquer âncora que não casar aborta tudo.
--
--   CREATE OR REPLACE RESTAURA OS GRANTS PADRÃO (execute para PUBLIC). Os
--   grants são reaplicados no fim, iguais aos de hoje:
--     projecao_calcular_filial   → só postgres + service_role
--     projecao_calcular_operador → só postgres + service_role
--     tv_snapshot_calcular       → postgres + service_role + authenticated
-- ============================================================================

begin;

do $patch$
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
       '  -- REGRA 2026-11-03 (gestao): o DIA CORRENTE entra na base do ritmo.'    || E'\n'
    || '  -- A projecao existe desde o 1o dia util do mes, com o honorario que ja' || E'\n'
    || '  -- entrou, mesmo com o dia em andamento -- e fica marcada como PARCIAL'  || E'\n'
    || '  -- na tela enquanto o dia nao fechou (projecao_parcial).'                || E'\n'
    || '  -- Mes encerrado: v_du_pass ja e o total, projecao = realizado.'         || E'\n'
    || '  v_parcial := (v_hoje between v_ini and v_fim) and public.dias_uteis(v_hoje, v_hoje) = 1;' || E'\n';

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

    -- 1.a  cai o desconto do dia corrente; entra a marca de parcial.
    --      Âncora: o comentário da premissa de 2026-08-17 + a linha do `- 1`.
    v_novo := regexp_replace(
      v_novo,
      '[ \t]*--[^\n]*PREMISSA 2026-08-17[^\n]*\n([ \t]*--[^\n]*\n)*[ \t]*if v_hoje <= v_fim then v_du_pass := greatest\(v_du_pass - 1, 0\); end if;[ \t]*\n',
      v_bloco
    );
    if v_novo = v_def then
      raise exception 'ANCORA 1.a nao casou em %', v_rec.assinatura;
    end if;

    -- 1.b  v_parcial declarado junto dos outros contadores de dia útil.
    if strpos(v_novo, 'v_du_rest int; v_du_pass int; v_du_total int;') = 0 then
      raise exception 'ANCORA 1.b nao casou em %', v_rec.assinatura;
    end if;
    v_novo := replace(
      v_novo,
      'v_du_rest int; v_du_pass int; v_du_total int;',
      'v_du_rest int; v_du_pass int; v_du_total int; v_parcial boolean;'
    );

    -- 1.c  dia corrente = dia LOCAL (ver cabeçalho).
    if strpos(v_novo, 'v_hoje date := current_date;') = 0 then
      raise exception 'ANCORA 1.c nao casou em %', v_rec.assinatura;
    end if;
    v_novo := replace(
      v_novo,
      'v_hoje date := current_date;',
      'v_hoje date := (now() at time zone ''America/Sao_Paulo'')::date;'
    );

    -- 1.d  projecao_parcial no payload, ao lado dos dias úteis.
    if strpos(v_novo, '''dias_uteis_passados'', v_du_pass,') = 0 then
      raise exception 'ANCORA 1.d nao casou em %', v_rec.assinatura;
    end if;
    v_novo := replace(
      v_novo,
      '''dias_uteis_passados'', v_du_pass,',
      '''projecao_parcial'', v_parcial,' || E'\n    ' || '''dias_uteis_passados'', v_du_pass,'
    );

    -- guardas finais: o desconto saiu, a marca entrou, a conta ficou de pé.
    if strpos(v_novo, 'v_du_pass - 1') > 0 then
      raise exception 'GUARDA: desconto do dia corrente sobrou em %', v_rec.assinatura;
    end if;
    if strpos(v_novo, 'projecao_parcial') = 0
       or strpos(v_novo, '(v_hon_mes / v_du_pass) * v_du_total') = 0 then
      raise exception 'GUARDA: payload/conta inesperados em %', v_rec.assinatura;
    end if;

    execute v_novo;
    raise notice 'patch aplicado: %', v_rec.assinatura;
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

  -- 2.a  declaração
  if strpos(v_novo, 'v_du_mes int; v_du_ate int; v_du_rest int;') = 0 then
    raise exception 'ANCORA 2.a nao casou';
  end if;
  v_novo := replace(
    v_novo,
    'v_du_mes int; v_du_ate int; v_du_rest int;',
    'v_du_mes int; v_du_ate int; v_du_rest int; v_parcial boolean;'
  );

  -- 2.b  cai o desconto; "restantes" passa a ser contado direto pelo helper,
  --      com o MESMO sentido do CRM (hoje conta como restante). O valor de hoje
  --      não muda: 19 - 0 = 19 antes, dias_uteis(hoje, fim) = 19 agora. De
  --      quebra conserta sábado/domingo, em que a fórmula antiga
  --      (v_du_mes - (v_du_ate - 1)) devolvia 1 restante a mais.
  v_novo := regexp_replace(
    v_novo,
    '[ \t]*--[^\n]*PREMISSA 2026-08-17[^\n]*\n([ \t]*--[^\n]*\n)*[ \t]*v_du_ate := greatest\(0, v_du_ate - 1\);[ \t]*\n[ \t]*v_du_rest := greatest\(0, v_du_mes - v_du_ate\);[ \t]*\n',
       '  -- REGRA 2026-11-03 (gestao): o DIA CORRENTE entra na base do ritmo'   || E'\n'
    || '  -- (v_du_ate ja inclui hoje), para a projecao existir desde o 1o dia'  || E'\n'
    || '  -- util. "Restantes" segue contando hoje -- o dia ainda vai fechar --' || E'\n'
    || '  -- pela mesma formula do CRM, para TV e CRM nao divergirem.'           || E'\n'
    || '  v_du_rest := public.dias_uteis(current_date, (date_trunc(''month'',current_date) + interval ''1 month - 1 day'')::date);' || E'\n'
    || '  v_parcial := public.dias_uteis(current_date, current_date) = 1;'       || E'\n'
  );
  if v_novo = v_def then
    raise exception 'ANCORA 2.b nao casou';
  end if;

  -- 2.c  projecao_parcial nos dois objetos que carregam a projeção
  if strpos(v_novo, '''dias_restantes'', v_du_rest, ''dias_uteis_mes'', v_du_mes,') = 0
     or strpos(v_novo, '''dias_uteis_mes'', v_du_mes, ''dias_uteis_transcorridos'', v_du_ate, ''dias_uteis_restantes'', v_du_rest,') = 0 then
    raise exception 'ANCORA 2.c nao casou';
  end if;
  v_novo := replace(
    v_novo,
    '''dias_restantes'', v_du_rest, ''dias_uteis_mes'', v_du_mes,',
    '''projecao_parcial'', v_parcial,' || E'\n    ' || '''dias_restantes'', v_du_rest, ''dias_uteis_mes'', v_du_mes,'
  );
  v_novo := replace(
    v_novo,
    '''dias_uteis_mes'', v_du_mes, ''dias_uteis_transcorridos'', v_du_ate, ''dias_uteis_restantes'', v_du_rest,',
    '''projecao_parcial'', v_parcial,' || E'\n    ' || '''dias_uteis_mes'', v_du_mes, ''dias_uteis_transcorridos'', v_du_ate, ''dias_uteis_restantes'', v_du_rest,'
  );

  if strpos(v_novo, 'v_du_ate - 1') > 0 then
    raise exception 'GUARDA: desconto do dia corrente sobrou na TV';
  end if;
  if strpos(v_novo, 'v_hon::numeric / v_du_ate * v_du_mes') = 0 then
    raise exception 'GUARDA: conta da projecao da TV inesperada';
  end if;

  execute v_novo;
  raise notice 'patch aplicado: tv_snapshot_calcular()';
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
       strpos(pg_get_functiondef(p.oid), 'projecao_parcial') > 0 as tem_flag,
       strpos(pg_get_functiondef(p.oid), '- 1')               > 0 as tem_desconto
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('projecao_calcular_filial','projecao_calcular_operador','tv_snapshot_calcular')
order by p.proname;

-- ESPERADO
--   projecao_calcular_filial    postgres=X/postgres | service_role=X/postgres                     t  f
--   projecao_calcular_operador  postgres=X/postgres | service_role=X/postgres                     t  f
--   tv_snapshot_calcular        postgres=X/postgres | authenticated=X/postgres | service_role=…    t  f

commit;

-- ============================================================================
-- DEPOIS DO COMMIT — regerar os snapshots (as funções acima só calculam):
--   · CRM: botão "Atualizar projeção" na tela (ou select public.projecao_snapshot_atualizar('2026-11'))
--   · TV:  select public.tv_snapshot_atualizar();  -- ou esperar o cron 85 (*/15 11-23 * * 1-5)
--
-- CONFERÊNCIA DE VALOR, novembro/2026 (19 dias úteis):
--   select payload->>'dias_uteis_passados'       as base,
--          payload->>'dias_uteis_total_mes'      as total,
--          payload->>'honorario_mes'             as realizado,
--          payload->>'projecao_honorario_filial' as projecao,
--          payload->>'projecao_parcial'          as parcial
--   from public.projecao_snapshot
--   where escopo = 'FILIAL' and mes_referencia = '2026-11';
--   -- esperado em 03/11: base 1 · total 19 · realizado 4073.80
--   --                    projecao 77402.20 · parcial true
-- ============================================================================
