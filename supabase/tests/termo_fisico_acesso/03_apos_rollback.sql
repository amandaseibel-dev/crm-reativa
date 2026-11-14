-- Depois do rollback: RPCs removidas, histórico preservado, tabela arquivada sem
-- acesso da aplicação e com as triggers ainda ativas.
\set ON_ERROR_STOP on

select public.teste_assert('rollback: RPC de leitura removida (undefined_function 42883)',
  public.teste_consulta('authenticated', 'amanda.seibel@aelbra.com.br',
    'select public.termo_fisico_ler(''a0000000-0000-0000-0000-000000000042'')')->>'code' = '42883');
select public.teste_assert('rollback: RPC de registro removida (undefined_function 42883)',
  public.teste_comando('authenticated', 'amanda.seibel@aelbra.com.br',
    'select public.termo_fisico_registrar(''a0000000-0000-0000-0000-000000000042'',''ARQUIVADO'',false)')->>'code' = '42883');

select public.teste_assert('rollback: histórico preservado na tabela arquivada (2 registros)',
  (select count(*) from public.aluno_termo_fisico_eventos_descartada_20261113) = 2);

-- Revogar acessos NÃO desliga as triggers: a tabela arquivada continua imutável.
select public.teste_assert('rollback: tabela arquivada sem privilégio para anon, authenticated e service_role',
  not exists (
    select 1
      from unnest(array['anon','authenticated','service_role']) as p(papel),
           unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as o(op)
     where has_table_privilege(p.papel, 'public.aluno_termo_fisico_eventos_descartada_20261113', o.op)));
select public.teste_assert('rollback: tabela arquivada sem entrada de PUBLIC na ACL',
  not exists (select 1 from aclexplode((select relacl from pg_class
                 where oid = 'public.aluno_termo_fisico_eventos_descartada_20261113'::regclass)) a where a.grantee = 0));

select public.teste_assert('rollback: gestão não lê a tabela arquivada',
  public.teste_consulta('authenticated', 'amanda.seibel@aelbra.com.br',
    'select * from public.aluno_termo_fisico_eventos_descartada_20261113')->>'code' = '42501');

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
