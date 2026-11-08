-- DEPOIS DO ROLLBACK: o banco tem de voltar ao estado anterior a migration.
\set ON_ERROR_STOP on

do $$ begin
  perform public.afirmar(to_regclass('public.ulbra_operadores_vinculo') is null,
    'a tabela nao existe mais');
  -- Policy some com a tabela; a conferencia e pelo catalogo, nao pela fe.
  perform public.afirmar(
    not exists (select 1 from pg_policy where polname = 'ulbra_operadores_vinculo_gestao_le'),
    'a policy nao sobrou no catalogo');
  -- Nada de indice ou constraint orfao com o nome da tabela.
  perform public.afirmar(
    not exists (select 1 from pg_class where relname like 'ulbra_operadores_vinculo%'),
    'nenhum indice ou constraint orfao sobrou');
  -- O rollback NAO pode ter levado junto o que nao era dele.
  perform public.afirmar(to_regprocedure('public.usuario_e_gestao()') is not null,
    'usuario_e_gestao() continua de pe -- o rollback nao passou do seu escopo');
end $$;

select 'ROLLBACK DO MAPEAMENTO: banco de volta ao estado anterior' as resultado;
