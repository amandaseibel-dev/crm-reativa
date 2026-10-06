-- A SEMANA DA TV PASSA A COMECAR NA SEGUNDA.
--
-- PEDIDO (Amanda, 06/10/2026): "melhor valor recuperado nao podemos zerar nas
-- segundas?".
--
-- COMO ESTAVA: `ranking_semana` usava `data_pagamento >= current_date - 6` --
-- uma janela MOVEL de 7 dias, nao a semana de calendario. Medido hoje (terca,
-- 06/10) a janela comecava em 30/09: o painel ainda carregava cinco dias da
-- semana anterior. A segunda tinha sido 05/10.
--
-- COMO FICA: `data_pagamento >= date_trunc('week', current_date)::date`. No
-- PostgreSQL `date_trunc('week', ...)` cai sempre na SEGUNDA (ISO-8601), entao
-- a contagem zera sozinha na virada da semana, sem cron e sem campo novo.
--
-- QUEM E AFETADO: a chave `ranking_semana` do snapshot, que alimenta a tela
-- "Destaque da Semana" (`snap?.ranking_semana_valor || snap?.dados?.ranking_semana`)
-- -- tanto no modo "Maior valor recuperado na semana" quanto no "Mais
-- pagamentos unicos da semana". `ranking_mes`, `recuperado_dia` e todo o resto
-- do payload ficam exatamente como estao.
--
-- EFEITO QUE A GESTAO PRECISA SABER: na segunda de manha a tela nasce vazia (ou
-- so com os pagamentos do proprio dia), em vez de mostrar o acumulado dos 7
-- dias anteriores. E o comportamento pedido, mas muda a cara do painel no
-- comeco da semana.
--
-- POR QUE PATCH ANCORADO e nao `create or replace` com o corpo inteiro:
-- `tv_snapshot_calcular` tem 18.406 bytes. Reescrever um corpo desse tamanho a
-- mao ja quebrou tela neste projeto -- a regra da casa e ler a definicao viva e
-- trocar SO o trecho. O bloco abaixo:
--   * exige encontrar EXATAMENTE uma ocorrencia da ancora (se o corpo mudar e
--     aparecerem duas, ou nenhuma, ele falha alto em vez de adivinhar);
--   * e idempotente pelo texto NOVO (rodar de novo nao faz nada);
--   * nao toca em mais nenhum byte da funcao.
--
-- Corpo antes: md5 6189e85f43c270527be8b639e799754d, 18406 bytes.
--
-- Rollback: supabase/rollbacks/20261006100000_tv_semana_comeca_na_segunda.rollback.sql

do $$
declare
  v_def   text;
  v_ancora constant text := 'data_pagamento >= current_date - 6';
  v_troca  constant text := 'data_pagamento >= date_trunc(''week'', current_date)::date';
  v_n int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular';

  if v_def is null then
    raise exception 'tv_snapshot_calcular nao encontrada em public';
  end if;

  -- IDEMPOTENCIA PELO TEXTO NOVO: se a semana ja comeca na segunda, sai quieto.
  if position(v_troca in v_def) > 0 then
    raise notice 'tv_snapshot_calcular ja usa a semana de calendario; nada a fazer';
    return;
  end if;

  v_n := (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora);
  if v_n <> 1 then
    raise exception
      'esperava exatamente 1 ocorrencia de "%" em tv_snapshot_calcular, encontrei %. '
      'O corpo mudou -- confira antes de aplicar.', v_ancora, v_n;
  end if;

  execute replace(v_def, v_ancora, v_troca);
end $$;
