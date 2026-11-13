-- Depois do rollback: RPCs removidas, histórico preservado, tabela arquivada sem
-- acesso da aplicação e com as triggers ainda ativas.
\set ON_ERROR_STOP on

select public.teste_assert('rollback: RPC de leitura removida',
  public.teste_consulta('authenticated', 'amanda.seibel@aelbra.com.br',
    'select public.termo_fisico_ler(''42'')')->>'ok' = 'false');
select public.teste_assert('rollback: RPC de registro removida',
  public.teste_comando('authenticated', 'amanda.seibel@aelbra.com.br',
    'select public.termo_fisico_registrar(''42'',''ARQUIVADO'',false)')->>'ok' = 'false');

select public.teste_assert('rollback: histórico preservado na tabela arquivada (2 registros)',
  (select count(*) from public.aluno_termo_fisico_eventos_descartada_20261113) = 2);

-- Revogar acessos NÃO desliga as triggers: a tabela arquivada continua imutável.
select public.teste_assert('rollback: tabela arquivada sem nenhum privilégio para os papéis da aplicação',
  not exists (
    select 1
      from unnest(array['public','anon','authenticated','service_role']) as p(papel),
           unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) as o(op)
     where has_table_privilege(p.papel, 'public.aluno_termo_fisico_eventos_descartada_20261113', o.op)));

select public.teste_assert('rollback: gestão não lê a tabela arquivada',
  public.teste_consulta('authenticated', 'amanda.seibel@aelbra.com.br',
    'select * from public.aluno_termo_fisico_eventos_descartada_20261113')->>'ok' = 'false');

select public.teste_assert('rollback: as três triggers continuam na tabela arquivada',
  (select count(*) from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
    where c.relname = 'aluno_termo_fisico_eventos_descartada_20261113'
      and not t.tgisinternal
      and t.tgname in ('aluno_termo_fisico_eventos_sem_update_delete',
                       'aluno_termo_fisico_eventos_sem_truncate')) = 2);

select public.teste_assert('rollback: UPDATE, DELETE e TRUNCATE continuam bloqueados na tabela arquivada (dono)',
  public.teste_comando(null, null,
    'update public.aluno_termo_fisico_eventos_descartada_20261113 set situacao=''ARQUIVADO''')->>'err' like '%append-only%'
  and public.teste_comando(null, null,
    'delete from public.aluno_termo_fisico_eventos_descartada_20261113')->>'err' like '%append-only%'
  and public.teste_comando(null, null,
    'truncate public.aluno_termo_fisico_eventos_descartada_20261113')->>'err' like '%append-only%');
