-- A propria acao de resolver devolvia a pessoa para a fila.
--
-- Amanda, 31/08: "tem uns casos que atualizo e sai da fila, que esses casos nao
-- retornem pelo amor de deus" e "ja tem uns nomes que passaram umas duas vezes
-- nessa lista".
--
-- O DEFEITO. `universo` era um FULL OUTER JOIN entre `pg` (pagamentos ainda nao
-- conferidos) e `bx` (baixas do periodo). Clicar em "Feito" faz DUAS coisas:
--   1. registra a baixa                     -> a pessoa passa a existir em `bx`
--   2. marca os pagamentos como conferidos  -> a pessoa sai de `pg`
-- Com FULL OUTER JOIN, o passo 1 recria a linha que o passo 2 acabou de tirar.
-- A pessoa reaparece com `entrou = 0`: nada para conferir, mas ocupando a fila e
-- parecendo trabalho a fazer.
--
-- E o pior tipo de defeito de fila -- quanto MAIS a pessoa trabalha, mais a fila
-- devolve. Explica o "passaram duas vezes nessa lista".
--
-- Medido em 31/08, julho + agosto:
--
--                                  antes            depois
--   com pagamento a conferir       1.946            1.946
--   entrou = 0, JA DECIDIDAS          78                0
--
-- A CORRECAO: `bx` deixa de criar linha e passa a so enriquecer (LEFT JOIN). A
-- fila e sobre DINHEIRO A CONFERIR; quem nao tem pagamento pendente nao tem o
-- que fazer ali. A coluna "baixado" segue aparecendo para quem esta na fila por
-- pagamento -- so nao inventa mais uma linha por causa dela.
--
-- DESFAZER: supabase/rollbacks/20260831220000_fila_nao_devolve_quem_ja_foi_resolvido.rollback.sql

do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='conferencia_pagamentos';

  if v_def is null then
    raise exception 'conferencia_pagamentos nao existe -- migration fora de ordem';
  end if;
  if v_def like '%from pg left join bx%' then return; end if;

  v_novo := replace(v_def,
    'from pg full outer join bx on bx.aid = pg.aid',
    'from pg left join bx on bx.aid = pg.aid');

  if v_novo = v_def then
    raise exception 'o full outer join nao casou -- nada alterado';
  end if;
  execute v_novo;
end $do$;
