-- ============================================================================
-- AUDITORIA DE SEGURANÇA — CRM ReATIVA  (SOMENTE LEITURA)
-- Rodar antes de cada deploy. NÃO altera grants, policies, dados ou estrutura.
-- Uso:  supabase db execute -f scripts/seguranca/auditoria_seguranca.sql
--       ou colar no SQL editor do projeto alvo (prod=ahattpqrjmhkzsmnbdzs).
-- Saída: uma linha por achado. Coluna gravidade IN ('BLOQUEIA','ALERTA','INFO').
--        Qualquer 'BLOQUEIA' reprova o Security Gate (ver CHECKLIST_SEGURANCA_DEPLOY.md).
-- ============================================================================
with

-- 1) Tabelas em public sem RLS. BLOQUEIA se alcançável por anon/authenticated (grant);
--    ALERTA se sem grant (só service_role/postgres) — ainda deve ligar RLS deny-all.
tab_sem_rls as (
  select case when exists (select 1 from information_schema.role_table_grants g
                where g.table_schema='public' and g.table_name=t.tablename
                  and g.grantee in ('anon','authenticated'))
              then 'BLOQUEIA' else 'ALERTA' end ::text gravidade,
         'TABELA_SEM_RLS' check_id, t.tablename obj,
         'Tabela em public com RLS desligada' detalhe
  from pg_tables t
  where t.schemaname='public' and t.rowsecurity=false
    and t.tablename not like 'pg_%'
),

-- 2) Tabelas com RLS mas 0 policies E com grant a anon/authenticated (deny-all só é ok sem grant)
rls_sem_policy_com_grant as (
  select 'ALERTA', 'RLS_SEM_POLICY_COM_GRANT', t.tablename,
         'RLS ligada, 0 policies, porém com grant a anon/authenticated'
  from pg_tables t
  where t.schemaname='public' and t.rowsecurity=true
    and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=t.tablename)
    and exists (select 1 from information_schema.role_table_grants g
                where g.table_schema='public' and g.table_name=t.tablename
                  and g.grantee in ('anon','authenticated'))
),

-- 3) Policies amplas: USING(true)/WITH CHECK(true) para anon/authenticated/public
policy_ampla as (
  select 'ALERTA', 'POLICY_AMPLA', p.tablename||'.'||p.policyname,
         'cmd='||p.cmd||' roles='||p.roles::text||' using='||coalesce(p.qual,'-')||' check='||coalesce(p.with_check,'-')
  from pg_policies p
  where p.schemaname='public'
    and (p.roles::text ~ '(anon|authenticated|public)')
    and ( p.qual in ('true') or p.with_check in ('true')
          or p.qual ~ 'auth\.role\(\)\s*=\s*''authenticated''' )
),

-- 4) Grant ALL (ou DELETE/INSERT/UPDATE) a anon em tabela operacional = superfície ampla
grant_anon_escrita as (
  select 'ALERTA', 'GRANT_ANON_ESCRITA', g.table_name||'->'||g.privilege_type,
         'anon possui '||g.privilege_type||' (protegido só por RLS)'
  from information_schema.role_table_grants g
  where g.table_schema='public' and g.grantee='anon'
    and g.privilege_type in ('INSERT','UPDATE','DELETE')
    and g.table_name in ('alunos','casos','pagamentos','acordos','parcelas','acordos_titulos',
      'usuarios','baixas_pagamento','termos_acordo','solicitacoes_confirmacao_pagamento')
),

-- 5) RPC SECURITY DEFINER sem search_path fixo (CRÍTICO)
rpc_sem_searchpath as (
  select 'BLOQUEIA', 'RPC_SECDEF_SEM_SEARCHPATH', p.proname,
         'SECURITY DEFINER sem search_path fixo'
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef and p.proconfig is null
),

-- 6) RPC SECURITY DEFINER chamável (prokind=f) executável por anon/public
--    -> exige revisão de autorização interna (enumeração/PII/escrita)
rpc_execute_amplo as (
  select 'ALERTA', 'RPC_SECDEF_EXECUTE_ANON', p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
         'SECURITY DEFINER executável por anon/public — confirmar gate interno'
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef and p.prokind='f'
    and (has_function_privilege('anon', p.oid,'EXECUTE') or has_function_privilege('public', p.oid,'EXECUTE'))
),

-- 7) Views security_invoker=off com grant a anon/authenticated (possível bypass de RLS)
view_bypass as (
  select 'BLOQUEIA', 'VIEW_BYPASS_RLS', c.relname,
         'security_invoker=off e SELECT concedido a anon/authenticated'
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='v'
    and coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker'),'off')='off'
    and exists (select 1 from information_schema.role_table_grants g
                where g.table_schema='public' and g.table_name=c.relname
                  and g.grantee in ('anon','authenticated'))
),

-- 8) Buckets públicos
bucket_publico as (
  select 'BLOQUEIA', 'BUCKET_PUBLICO', b.name, 'Bucket de storage público'
  from storage.buckets b where b.public=true
)

select * from tab_sem_rls
union all select * from rls_sem_policy_com_grant
union all select * from policy_ampla
union all select * from grant_anon_escrita
union all select * from rpc_sem_searchpath
union all select * from rpc_execute_amplo
union all select * from view_bypass
union all select * from bucket_publico
order by case gravidade when 'BLOQUEIA' then 0 when 'ALERTA' then 1 else 2 end, check_id, obj;

-- Complementos fora do SQL (rodar no CI/host, ver CHECKLIST §B):
--   grep -rniE 'service_role|SERVICE_ROLE' src/            -> service_role no bundle
--   grep -rn  'edlzlfba' dist/ src/                        -> ref de staging no bundle de prod
--   grep -rnoE 'eyJ[A-Za-z0-9_-]{20,}' src/                -> JWT/segredo hardcoded
