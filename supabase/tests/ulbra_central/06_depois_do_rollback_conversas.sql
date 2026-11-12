-- DEPOIS DO ROLLBACK de ulbra_central_conversas: so a funcao some.
\set ON_ERROR_STOP on
do $$ begin
  perform public.afirmar(to_regprocedure('public.ulbra_central_conversas(timestamptz, text, integer, integer)') is null, 'ulbra_central_conversas nao existe mais');
  perform public.afirmar(to_regprocedure('public.ulbra_central_operador(text, integer, integer)') is not null, 'ulbra_central_operador continua de pe');
  perform public.afirmar((select count(*) from public.ulbra_conversas where ulbra_conversa_id like 'p-%' or ulbra_conversa_id in ('q-nov','r-nov','x-nov')) = 6, 'o espelho nao foi tocado');
end $$;
select 'ROLLBACK DAS CONVERSAS DO PERIODO: so a funcao saiu' as resultado;
