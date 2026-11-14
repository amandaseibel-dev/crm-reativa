-- ============================================================================
-- AGREGADO DA AUDITORIA DE SEGURANCA (scripts/seguranca/auditoria_seguranca.sql)
-- SOMENTE LEITURA: so SELECT sobre catalogo e storage.buckets. Nenhum DML.
--
-- Por que existe: auditoria_seguranca.sql, como esta no repositorio, FALHA no
-- Postgres (0A000: ORDER BY com expressao sobre UNION). Esta consulta tem os
-- MESMOS 8 criterios e as mesmas condicoes, agregados por tipo de achado, com a
-- ordenacao numa subconsulta. Serve so para registrar o que a auditoria mediria.
-- Nao substitui a correcao do gate (defeito de script, PR propria).
-- ============================================================================
with
tab_sem_rls as (
  select case when exists (select 1 from information_schema.role_table_grants g
                where g.table_schema='public' and g.table_name=t.tablename
                  and g.grantee in ('anon','authenticated'))
              then 'BLOQUEIA' else 'ALERTA' end ::text gravidade,
         'TABELA_SEM_RLS' check_id, t.tablename obj
  from pg_tables t where t.schemaname='public' and t.rowsecurity=false and t.tablename not like 'pg_%'
),
rls_sem_policy_com_grant as (
  select 'ALERTA'::text gravidade, 'RLS_SEM_POLICY_COM_GRANT' check_id, t.tablename obj
  from pg_tables t where t.schemaname='public' and t.rowsecurity=true
    and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=t.tablename)
    and exists (select 1 from information_schema.role_table_grants g where g.table_schema='public' and g.table_name=t.tablename and g.grantee in ('anon','authenticated'))
),
policy_ampla as (
  select 'ALERTA'::text, 'POLICY_AMPLA', p.tablename||'.'||p.policyname
  from pg_policies p where p.schemaname='public' and (p.roles::text ~ '(anon|authenticated|public)')
    and ( p.qual in ('true') or p.with_check in ('true') or p.qual ~ 'auth\.role\(\)\s*=\s*''authenticated''' )
),
grant_anon_escrita as (
  select 'ALERTA'::text, 'GRANT_ANON_ESCRITA', g.table_name||'->'||g.privilege_type
  from information_schema.role_table_grants g
  where g.table_schema='public' and g.grantee='anon' and g.privilege_type in ('INSERT','UPDATE','DELETE')
    and g.table_name in ('alunos','casos','pagamentos','acordos','parcelas','acordos_titulos','usuarios','baixas_pagamento','termos_acordo','solicitacoes_confirmacao_pagamento')
),
rpc_sem_searchpath as (
  select 'BLOQUEIA'::text, 'RPC_SECDEF_SEM_SEARCHPATH', p.proname
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef and p.proconfig is null
),
rpc_execute_amplo as (
  select 'ALERTA'::text, 'RPC_SECDEF_EXECUTE_ANON', p.proname
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef and p.prokind='f'
    and (has_function_privilege('anon', p.oid,'EXECUTE') or has_function_privilege('public', p.oid,'EXECUTE'))
),
view_bypass as (
  select 'BLOQUEIA'::text, 'VIEW_BYPASS_RLS', c.relname
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='v'
    and coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker'),'off')='off'
    and exists (select 1 from information_schema.role_table_grants g where g.table_schema='public' and g.table_name=c.relname and g.grantee in ('anon','authenticated'))
),
bucket_publico as (
  select 'BLOQUEIA'::text, 'BUCKET_PUBLICO', b.name from storage.buckets b where b.public=true
),
achados as (
  select * from tab_sem_rls union all select * from rls_sem_policy_com_grant
  union all select * from policy_ampla union all select * from grant_anon_escrita
  union all select * from rpc_sem_searchpath union all select * from rpc_execute_amplo
  union all select * from view_bypass union all select * from bucket_publico
)
select gravidade, check_id, count(*) as quantos,
       case when gravidade='BLOQUEIA' or count(*)<=12 then string_agg(obj, ', ' order by obj)
            else '(' || count(*) || ' itens)' end as objetos
from achados group by gravidade, check_id
order by case gravidade when 'BLOQUEIA' then 0 when 'ALERTA' then 1 else 2 end, check_id;
