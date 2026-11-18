-- Consultas de LEITURA usadas em 17/11/2026 para o pacote da PR #913 (projeto ahattpqrjmhkzsmnbdzs).
-- Nenhuma escrita. Os resultados estão resumidos em docs/integracoes/pacote-historico-e-resposta-2026-11-11.md.
-- Versionadas para reprodução. Reexecutar exige acesso de leitura ao projeto.

-- (1) Grants e políticas de public.auditoria
select 'grant' as tipo, grantee::text as quem, privilege_type::text as detalhe
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'auditoria' and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
union all
select 'policy', policyname::text, cmd || ' roles=' || array_to_string(roles, ',') || ' qual=' || coalesce(with_check, qual, '')
from pg_policies where schemaname = 'public' and tablename = 'auditoria'
union all
select 'rls', 'enabled=' || relrowsecurity::text, 'forced=' || relforcerowsecurity::text
from pg_class where oid = 'public.auditoria'::regclass
order by 1, 2;

-- (2) Políticas com permissividade e a definição de eh_painel()
select p.policyname, p.permissive, p.cmd,
       pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check,
       pg_get_expr(pol.polqual, pol.polrelid) as using_expr
from pg_policy pol
join pg_policies p on p.policyname = pol.polname and p.schemaname = 'public' and p.tablename = 'auditoria'
where pol.polrelid = 'public.auditoria'::regclass;

-- (3) Funções que mencionam inserção em auditoria, com modo de segurança e grants
select p.oid::regprocedure::text as funcao,
       case when p.prosecdef then 'DEFINER' else 'INVOKER' end as seguranca,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as exec_authenticated,
       has_function_privilege('anon', p.oid, 'EXECUTE') as exec_anon
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public','internal') and p.prokind = 'f'
  and p.prosrc ~* '\minto\s+(public\.)?auditoria\M'
order by 1;

-- (4) Corpo da função INVOKER confirmada (linhas que tocam auditoria)
select p.proname, pg_get_userbyid(p.proowner) as dono,
       (select string_agg(substring(m.line from 1 for 160), ' | ')
          from regexp_split_to_table(p.prosrc, E'\n') as m(line)
         where m.line ~* 'auditoria') as linhas_auditoria
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = '_titulo_em_confirmacao_protegido';
