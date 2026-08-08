-- Corrige e consolida RLS de SELECT nas 3 tabelas de historico cuja politica
-- principal era USING true. O painel.tv NAO estava sendo bloqueado: a regra `true`
-- anulava `painel_negado_select` via OR (politicas permissivas somam por OR).
-- Torna o bloqueio efetivo (NOT eh_painel()) e funde 2 politicas em 1.
-- Operadores normais: SEM mudanca (seguem com acesso amplo a essas tabelas de auditoria).
--
-- NOTA: historico_agendamentos e historico_operadores_alunos tem OUTRO problema
-- (painel_negado_select abre acesso amplo a todos os autenticados, furando o escopo
-- por operador). NAO tratado aqui: mudar aquilo altera o que o operador enxerga na
-- ficha e precisa de decisao de produto + teste.

alter policy historico_alteracoes_select_authenticated on public.historico_alteracoes_crm using (not public.eh_painel());
drop policy painel_negado_select on public.historico_alteracoes_crm;

alter policy historico_select_authenticated on public.historico_atendimentos using (not public.eh_painel());
drop policy painel_negado_select on public.historico_atendimentos;

alter policy historico_links_select_authenticated on public.historico_links_pagamento using (not public.eh_painel());
drop policy painel_negado_select on public.historico_links_pagamento;
