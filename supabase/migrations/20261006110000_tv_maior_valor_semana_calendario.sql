-- "MAIOR VALOR RECUPERADO NA SEMANA": o indicador passa a EXISTIR, e por semana
-- de calendario (segunda ate agora), no fuso de Sao Paulo.
--
-- ACHADO QUE MUDA O PEDIDO. A tela "Destaque da Semana" le:
--
--   const semana = snap?.ranking_semana_valor || snap?.dados?.ranking_semana || [];
--   const porValor = campeao.valor != null;
--
-- `ranking_semana_valor` NUNCA FOI PRODUZIDO -- zero ocorrencias em todo o banco,
-- e a chave nao existe no payload (conferido no snapshot 511). O fallback
-- `dados.ranking_semana` traz `{operador, pagos}`, SEM campo `valor`. Logo
-- `porValor` e sempre falso e a tela sempre mostrou "Mais pagamentos unicos da
-- semana": o rotulo "Maior valor recuperado na semana" e codigo morto desde
-- sempre. Nao era janela errada -- o indicador nao existia.
--
-- Esta migration faz as duas coisas, no mesmo lugar:
--
--   1) CRIA `ranking_semana_valor` -- soma de `valor_pago` por operador, mesma
--      lista de operadores e mesmo limite de 8 do `ranking_semana`;
--   2) TROCA A JANELA dos dois para a semana de CALENDARIO.
--
-- A JANELA. Era `data_pagamento >= current_date - 6` -- 7 dias moveis. Passa a
-- `data_pagamento >= date_trunc('week', v_hoje)::date`. No PostgreSQL
-- `date_trunc('week', ...)` cai sempre na SEGUNDA (ISO-8601): segunda inicia a
-- semana, terca a domingo acumulam desde ela, e na segunda seguinte reinicia
-- sozinho -- sem cron e sem campo novo.
--
-- FUSO. Usa `v_hoje`, que a propria funcao ja declara como
-- `(now() at time zone 'America/Sao_Paulo')::date` e ja emprega em 13 pontos.
-- `current_date` seria a data do SERVIDOR (UTC) e viraria a semana na hora
-- errada. Esta e a diferenca entre o pedido e o que havia.
--
-- NAO TOCA: `ranking_mes`, `recuperado_dia`, `honorarios_dia`, projecao, metas,
-- premiacao nem qualquer outra tela. So a secao da semana.
--
-- `public.dashboard_tv` tambem tem a janela de 7 dias, mas NENHUMA tela do front
-- a chama (varredura em src/: zero). Fica como esta, de proposito.
--
-- EFEITO QUE A GESTAO PRECISA SABER: na segunda de manha a tela nasce vazia --
-- `ranking_semana_valor` volta `[]` e a tela diz "Sem dados da semana" ate o
-- primeiro pagamento do dia. E o comportamento pedido.
--
-- PATCH ANCORADO, nao `create or replace` com o corpo inteiro:
-- `tv_snapshot_calcular` tem 18.406 bytes (md5 6189e85f43c270527be8b639e799754d)
-- e reescrever corpo desse tamanho a mao ja quebrou tela neste projeto. Cada
-- troca exige EXATAMENTE uma ocorrencia da ancora e e idempotente pelo texto
-- NOVO.
--
-- Rollback: supabase/rollbacks/20261006110000_tv_maior_valor_semana_calendario.rollback.sql

do $$
declare
  v_def text;
  v_n   int;

  -- 1) janela movel -> semana de calendario, no fuso de Sao Paulo
  c_janela_velha constant text := 'data_pagamento >= current_date - 6';
  c_janela_nova  constant text := 'data_pagamento >= date_trunc(''week'', v_hoje)::date';

  -- 2) indicador que faltava, inserido imediatamente antes de `ranking_mes`
  c_ancora_mes constant text := '''ranking_mes'',';
  c_bloco_novo constant text :=
    '''ranking_semana_valor'', (select coalesce(jsonb_agg(jsonb_build_object(''operador'', op, ''valor'', vl) order by vl desc), ''[]''::jsonb)'
    || E'\n      from (select op_norm op, round(sum(valor_pago)) vl from unif where data_pagamento >= date_trunc(''week'', v_hoje)::date and lower(operador_email) = any(v_ops) group by op_norm order by sum(valor_pago) desc limit 8) r),'
    || E'\n    ''ranking_mes'',';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular';

  if v_def is null then
    raise exception 'tv_snapshot_calcular nao encontrada em public';
  end if;

  -- IDEMPOTENCIA PELO TEXTO NOVO: se o indicador ja existe, nada a fazer.
  if position('ranking_semana_valor' in v_def) > 0 then
    raise notice 'ranking_semana_valor ja existe; nada a fazer';
    return;
  end if;

  -- (1) janela
  v_n := (length(v_def) - length(replace(v_def, c_janela_velha, ''))) / length(c_janela_velha);
  if v_n <> 1 then
    raise exception 'esperava 1 ocorrencia de "%", encontrei %. O corpo mudou.', c_janela_velha, v_n;
  end if;
  v_def := replace(v_def, c_janela_velha, c_janela_nova);

  -- (2) indicador novo
  v_n := (length(v_def) - length(replace(v_def, c_ancora_mes, ''))) / length(c_ancora_mes);
  if v_n <> 1 then
    raise exception 'esperava 1 ocorrencia de "%", encontrei %. O corpo mudou.', c_ancora_mes, v_n;
  end if;
  v_def := replace(v_def, c_ancora_mes, c_bloco_novo);

  execute v_def;
end $$;
