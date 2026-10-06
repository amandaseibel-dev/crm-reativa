-- Rollback de supabase/migrations/20261006110000_tv_maior_valor_semana_calendario.sql
--
-- Desfaz as duas coisas, na ordem inversa:
--   1) remove a chave `ranking_semana_valor` do payload;
--   2) devolve a janela movel de 7 dias (`current_date - 6`).
--
-- EFEITO DE RODAR ISTO: o "Destaque da Semana" volta a cair no fallback
-- `dados.ranking_semana`, que nao tem campo `valor` -- ou seja, volta a exibir
-- "Mais pagamentos unicos da semana" e o rotulo "Maior valor recuperado na
-- semana" volta a ser codigo morto. E a semana volta a nao zerar na segunda.
--
-- Mesma tecnica da migration: patch ancorado, idempotente pelo texto NOVO,
-- exigindo exatamente uma ocorrencia, para nao reescrever os 18.406 bytes.

do $$
declare
  v_def text;
  v_n   int;

  c_bloco constant text :=
    '''ranking_semana_valor'', (select coalesce(jsonb_agg(jsonb_build_object(''operador'', op, ''valor'', vl) order by vl desc), ''[]''::jsonb)'
    || E'\n      from (select op_norm op, round(sum(valor_pago)) vl from unif where data_pagamento >= date_trunc(''week'', v_hoje)::date and lower(operador_email) = any(v_ops) group by op_norm order by sum(valor_pago) desc limit 8) r),'
    || E'\n    ''ranking_mes'',';
  c_ancora_mes constant text := '''ranking_mes'',';

  c_janela_nova  constant text := 'data_pagamento >= date_trunc(''week'', v_hoje)::date';
  c_janela_velha constant text := 'data_pagamento >= current_date - 6';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular';

  if v_def is null then
    raise exception 'tv_snapshot_calcular nao encontrada em public';
  end if;

  if position('ranking_semana_valor' in v_def) = 0 then
    raise notice 'ranking_semana_valor nao existe; nada a desfazer';
    return;
  end if;

  -- (1) tira o indicador
  v_def := replace(v_def, c_bloco, c_ancora_mes);

  -- (2) devolve a janela movel
  v_n := (length(v_def) - length(replace(v_def, c_janela_nova, ''))) / length(c_janela_nova);
  if v_n <> 1 then
    raise exception 'esperava 1 ocorrencia de "%", encontrei %.', c_janela_nova, v_n;
  end if;
  v_def := replace(v_def, c_janela_nova, c_janela_velha);

  execute v_def;
end $$;
