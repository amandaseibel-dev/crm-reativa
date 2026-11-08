-- DEPOIS DO ROLLBACK do painel: a funcao some; o piloto fica de pe.
\set ON_ERROR_STOP on

do $$ begin
  perform public.afirmar(to_regprocedure('public.ulbra_painel_gestao()') is null,
    'ulbra_painel_gestao() nao existe mais');
  -- O rollback do painel NAO pode levar nada do piloto junto.
  perform public.afirmar(to_regclass('public.ulbra_sync_estado') is not null,
    'ulbra_sync_estado continua de pe');
  perform public.afirmar(to_regprocedure('public.ulbra_sync_gravar(jsonb)') is not null,
    'ulbra_sync_gravar continua de pe');
  perform public.afirmar((select count(*) from public.ulbra_conversas) = 3,
    'o espelho nao foi tocado');
end $$;

select 'ROLLBACK DO PAINEL: so a funcao saiu' as resultado;
