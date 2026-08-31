-- A fila de conferencia escondia o ULTIMO DIA do periodo escolhido.
--
-- Amanda, 31/08, sobre os valores de julho: "mas isso e o que preciso, ter uma
-- fila para baixar esses valores no sistema". Conferindo o total da fila contra
-- o total de julho, os numeros nao bateram -- e a diferenca era um defeito.
--
-- `conferencia_pagamentos` comparava `data_pagamento < v_ate`, com v_ate sendo
-- a data que a tela manda. Quem escolhe "ate 31/07" quer o dia 31 INCLUIDO;
-- a funcao devolvia so ate 30/07.
--
-- Medido em 31/08/2026, julho de 2026:
--
--   ate 31/07 (com o defeito)   1.353 pessoas   2.577 pgtos   R$ 3.492.029,34
--   julho inteiro               1.428 pessoas   2.732 pgtos   R$ 3.763.084,18
--   ----------------------------------------------------------------------
--   escondido                      75 pessoas     155 pgtos   R$   271.054,84
--
-- Nao era so julho: o ultimo dia de QUALQUER intervalo caia fora, inclusive o
-- dia corrente quando o periodo termina hoje. Dinheiro que entrou, precisa de
-- baixa, e nao aparecia para ninguem na tela que existe justamente para isso.
--
-- A correcao e `p_ate + 1`, mantendo o `<`. Assim `data_pagamento < p_ate + 1`
-- e o mesmo que `<= p_ate`, e vale para as duas pontas -- os pagamentos (`pg`)
-- e as baixas ja feitas (`bx`), que usam o mesmo v_ate.
--
-- POR QUE `p_ate + 1` E NAO TROCAR `<` POR `<=`: `v_ate` tambem serve de valor
-- padrao quando a tela nao manda data nenhuma (2999-12-31). Mexendo so no
-- calculo do limite, as duas comparacoes seguem identicas e nao ha risco de
-- alguem corrigir uma e esquecer a outra.
--
-- DESFAZER: supabase/rollbacks/20260831120000_fila_conferencia_inclui_o_ultimo_dia.rollback.sql
--
-- Aplicado em prod por substituicao da linha do `declare`, preservando o corpo
-- inteiro da funcao. Este arquivo repete a mesma substituicao, para o repo
-- descrever exatamente o que foi feito.

do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'conferencia_pagamentos';

  if v_def is null then
    raise exception 'conferencia_pagamentos nao existe -- migration fora de ordem';
  end if;

  -- ja corrigida? entao nao ha o que fazer
  if v_def like '%coalesce(p_ate + 1,%' then
    return;
  end if;

  v_novo := replace(v_def,
    'declare v_ate date := coalesce(p_ate, date ''2999-12-31'');',
    'declare v_ate date := coalesce(p_ate + 1, date ''2999-12-31'');');

  if v_novo = v_def then
    raise exception 'a linha do v_ate nao casou -- nada alterado, confira a funcao';
  end if;

  execute v_novo;
end $do$;
