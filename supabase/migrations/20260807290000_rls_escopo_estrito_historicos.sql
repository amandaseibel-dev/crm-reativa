-- Opcao (A) ESTRITO (decisao Amanda 2026-08-07): remove painel_negado_select das
-- 2 tabelas onde ela furava o escopo. painel_negado_select = NOT eh_painel() era
-- TRUE para todo operador -> via OR liberava TODOS os registros a qualquer
-- autenticado, furando a politica principal (gestao OR meus casos) = exposicao LGPD.
-- Ao remove-la, sobra so a politica principal, que ja bloqueia o painel.tv.
-- Efeito: operador ve apenas registros em que esteve envolvido; gestao ve tudo.
-- Reversivel: recriar `create policy painel_negado_select ... using (not eh_painel())`.

drop policy painel_negado_select on public.historico_agendamentos;
drop policy painel_negado_select on public.historico_operadores_alunos;
