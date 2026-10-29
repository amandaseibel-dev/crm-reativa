-- A fila passa a comecar por quem tem MENSALIDADE em aberto.
--
-- Amanda, 31/08: "prioridade deveria ser os casos que tem mensalidade em aberto".
--
-- POR QUE FAZ DIFERENCA. Mensalidade em aberto e divida crua, que conta inteira
-- na carteira. Parcela de acordo ja e divida organizada, com data e valor
-- combinados. Baixar o dinheiro de quem tem mensalidade e o que efetivamente
-- reduz o que a operacao ve como em aberto -- e e onde o vinculo mensalidade x
-- acordo precisa ser feito.
--
-- Medido em 31/08, julho + agosto:
--   com mensalidade em aberto   1.214 pessoas   R$ 1.715.159,01 entrou
--                                               R$ 1.939.532,60 de mensalidade
--   so acordo / sem mensalidade   826 pessoas   R$ 2.114.055,79 entrou
--
-- A ordem anterior era pelo VALOR QUE ENTROU. Isso jogava para o topo pagamentos
-- grandes de gente cujo saldo e so parcela de acordo -- dinheiro que so precisa
-- ser registrado, nao decidido.
--
-- O primeiro criterio segue sendo "pagou DEPOIS de ter sido quitado", que e o
-- que mais pede olho humano: pagamento em duplicidade, estorno a fazer ou
-- divida nova.
--
-- DESFAZER: supabase/rollbacks/20260831210000_fila_prioriza_mensalidade_em_aberto.rollback.sql

do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='conferencia_pagamentos';

  if v_def is null then
    raise exception 'conferencia_pagamentos nao existe -- migration fora de ordem';
  end if;
  if v_def like '%t.x_mens > 0.005%' then return; end if;

  v_novo := replace(v_def,
'   order by (t.x_quit is not null and t.ult is not null and t.ult > t.x_quit) desc,
            t.x_entrou desc, t.x_saldo desc, t.x_nome',
'   order by (t.x_quit is not null and t.ult is not null and t.ult > t.x_quit) desc,
            -- MENSALIDADE EM ABERTO PRIMEIRO: e divida crua, que conta inteira na
            -- carteira, e e onde o vinculo mensalidade x acordo precisa ser feito.
            -- Parcela de acordo ja e divida organizada -- so precisa do registro.
            (coalesce(t.x_mens,0) > 0.005) desc,
            t.x_mens desc, t.x_entrou desc, t.x_saldo desc, t.x_nome');

  if v_novo = v_def then raise exception 'o ORDER BY nao casou -- nada alterado'; end if;
  execute v_novo;
end $do$;
