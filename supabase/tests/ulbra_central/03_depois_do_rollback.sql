-- DEPOIS DO ROLLBACK da central: so a funcao some; piloto e painel ficam de pe.
\set ON_ERROR_STOP on

do $$ begin
  perform public.afirmar(to_regprocedure('public.ulbra_central_operador(text, integer, integer)') is null,
    'ulbra_central_operador(text, integer, integer) nao existe mais');
  perform public.afirmar(to_regprocedure('public.ulbra_painel_gestao()') is not null,
    'ulbra_painel_gestao() continua de pe');
  perform public.afirmar(to_regclass('public.ulbra_conversas') is not null
                     and to_regclass('public.ulbra_atendimentos') is not null,
    'o espelho continua de pe');
  perform public.afirmar((select count(*) from public.ulbra_conversas) = 12, 'o espelho nao foi tocado (5 do seed + 4 de paginacao + 3 de responsabilidade)');
end $$;

select 'ROLLBACK DA CENTRAL: so a funcao saiu' as resultado;
