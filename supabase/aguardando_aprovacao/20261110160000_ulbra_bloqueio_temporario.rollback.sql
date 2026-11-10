-- ROLLBACK do bloqueio: devolve EXECUTE somente à versão ATUAL e segura das funções
-- (identidade por vínculo alta_cpf). Não restaura versão anterior sem a checagem.
grant execute on function public.ulbra_central_operador(text, integer, integer) to authenticated;
grant execute on function public.ulbra_avisos_operador(integer) to authenticated;
