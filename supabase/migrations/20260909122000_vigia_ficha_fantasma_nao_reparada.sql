-- CORRECAO DE UM ERRO MEU. Em 09/09 eu relatei as 34 fichas fantasma
-- (R$ 89.988,24 em pagamentos pendurados) como reparadas. A primeira rodada do
-- vigia, no mesmo dia, encontrou as 34 intactas -- nenhuma delas tinha sido
-- tocada nos 3 dias anteriores. 17 das 34 tem ficha gemea com CPF e o mesmo
-- nome normalizado: candidatas a fusao, que so a gestao decide.
-- Fica GRAVE, com a linha de base dizendo a verdade.
update public.invariante_config
   set severidade  = 'GRAVE',
       explicacao  = 'Ficha sem CPF, sem caso e sem acordo, com pagamento pendurado nela: dinheiro recebido que nao aparece em nenhuma carteira. 17 das 34 tem ficha gemea com CPF e mesmo nome -- candidatas a fusao, que so a gestao decide.',
       base_09_09  = '34 · R$ 89.988,24 (NAO reparadas)'
 where nome = 'ficha_fantasma_com_pagamento';

update public.invariante_config
   set base_09_09 = '10 (as quedas de 08/09, antes da correcao da trava)'
 where nome = 'cron_com_falha';
