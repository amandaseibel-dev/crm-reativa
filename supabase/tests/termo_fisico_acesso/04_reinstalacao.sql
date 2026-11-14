-- Depois de reinstalar a migration e copiar o histórico arquivado:
-- sem duplicar, sem misturar, e a tabela arquivada continua protegida.
\set ON_ERROR_STOP on

-- Passo 3 do runbook de reinstalação (no próprio arquivo de rollback).
insert into public.aluno_termo_fisico_eventos
select * from public.aluno_termo_fisico_eventos_descartada_20261113
on conflict (id) do nothing;

select public.teste_assert('reinstalação: tabela nova tem os 2 registros copiados',
  (select count(*) from public.aluno_termo_fisico_eventos) = 2);

select public.teste_assert('reinstalação: os ids são exatamente os da tabela arquivada',
  not exists (
    (select id from public.aluno_termo_fisico_eventos_descartada_20261113
     except select id from public.aluno_termo_fisico_eventos)
    union all
    (select id from public.aluno_termo_fisico_eventos
     except select id from public.aluno_termo_fisico_eventos_descartada_20261113)));

select public.teste_assert('reinstalação: a tabela arquivada continua sem privilégio para anon, authenticated e service_role',
  not exists (
    select 1
      from unnest(array['anon','authenticated','service_role']) as p(papel),
           unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as o(op)
     where has_table_privilege(p.papel, 'public.aluno_termo_fisico_eventos_descartada_20261113', o.op)));
select public.teste_assert('reinstalação: a tabela arquivada continua sem entrada de PUBLIC na ACL',
  not exists (select 1 from aclexplode((select relacl from pg_class
                 where oid = 'public.aluno_termo_fisico_eventos_descartada_20261113'::regclass)) a where a.grantee = 0));
select public.teste_assert('reinstalação: o índice da tabela nova existe (nome livre após o rollback)',
  exists (select 1 from pg_indexes where schemaname = 'public'
            and tablename = 'aluno_termo_fisico_eventos'
            and indexname = 'aluno_termo_fisico_eventos_aluno_idx'));

select public.teste_assert('reinstalação: a tabela arquivada continua imutável',
  public.teste_comando(null, null,
    'update public.aluno_termo_fisico_eventos_descartada_20261113 set situacao=''ARQUIVADO''')->>'code' = '42501');

select public.teste_assert('reinstalação: a tabela nova continua imutável',
  public.teste_comando(null, null,
    'update public.aluno_termo_fisico_eventos set situacao=''ARQUIVADO''')->>'code' = '42501');

select public.teste_assert('reinstalação: gestão lê a tabela nova pela RPC',
  public.teste_consulta('authenticated', 'amanda.seibel@aelbra.com.br',
    'select public.termo_fisico_ler(''42'') as r')->>'ok' = 'true');

-- Reexecução dos acessos essenciais DEPOIS da reinstalação (sem depender da
-- contagem de dados, que mudou com a cópia do histórico).
select public.teste_assert('reinstalação: anon sem leitura nem execução',
  public.teste_consulta('anon', null, 'select * from public.aluno_termo_fisico_eventos')->>'code' = '42501'
  and public.teste_consulta('anon', null, 'select public.termo_fisico_ler(''a0000000-0000-0000-0000-000000000042'')')->>'code' = '42501');
select public.teste_assert('reinstalação: operador não vê nenhuma linha pela RLS',
  jsonb_array_length((public.teste_consulta('authenticated', 'operador.teste@exemplo.local',
    'select * from public.aluno_termo_fisico_eventos')->'rows')) = 0);
select public.teste_assert('reinstalação: operador não executa a RPC de leitura',
  public.teste_consulta('authenticated', 'operador.teste@exemplo.local',
    'select public.termo_fisico_ler(''a0000000-0000-0000-0000-000000000042'')')->>'code' = '42501');
select public.teste_assert('reinstalação: service_role sem privilégio na tabela nem nas funções',
  not has_table_privilege('service_role', 'public.aluno_termo_fisico_eventos', 'SELECT')
  and not has_function_privilege('service_role', 'public.termo_fisico_ler(text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.termo_fisico_registrar(text,text,boolean)', 'EXECUTE'));
select public.teste_assert('reinstalação: PUBLIC sem entrada na ACL das funções novas',
  not exists (select 1 from aclexplode((select proacl from pg_proc
                 where oid = 'public.termo_fisico_registrar(text,text,boolean)'::regprocedure)) a where a.grantee = 0));
