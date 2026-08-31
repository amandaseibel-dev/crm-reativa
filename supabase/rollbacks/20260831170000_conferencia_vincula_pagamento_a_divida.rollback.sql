-- DESFAZER 20260831170000_conferencia_vincula_pagamento_a_divida.sql
--
-- ATENCAO: desfazer faz a baixa voltar a entrar SOLTA -- sem parcela, sem
-- acordo, sem tocar em titulo. O saldo para de cair, `confirmar_baixa_caso`
-- volta a nunca quitar, e a unica saida vira de novo o botao que zera tudo.
--
-- Nao desfaz nada que ja foi ligado: as parcelas marcadas PAGO e os titulos
-- quitados por este caminho continuam como estao. Para reverter um caso
-- especifico, use o fluxo do Financeiro.

-- 1) a baixa volta a nao ligar nada
do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='conferencia_baixar_do_extrato';

  v_novo := regexp_replace(v_def,
    E'\\n[^\\n]*-- LIGA O DINHEIRO.*?conferencia_vincular_pagamento\\([^;]*\\);', '', 'ns');
  v_novo := replace(v_novo, ', ''vinculo'', v_vinculo);', ');');

  if v_novo = v_def then
    raise exception 'nada a desfazer -- a funcao nao esta na versao com vinculo';
  end if;
  execute v_novo;
end $do$;

-- 2) e a funcao de vinculo sai
drop function if exists public.conferencia_vincular_pagamento(uuid, numeric, date, uuid);
