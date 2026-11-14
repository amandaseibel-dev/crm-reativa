-- VALIDAÇÃO PÓS-APLICAÇÃO EM PRODUÇÃO — SOMENTE LEITURA.
-- Não registra, não notifica, não altera nada. Só SELECT.
-- Uso: colar no SQL editor do projeto ahattpqrjmhkzsmnbdzs, depois de aplicar a
-- migration da #954 com autorização. Cada linha é um item; 'ok' = false reprova.
with itens as (
  select 'tabela existe' item,
         exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                  where n.nspname='public' and c.relname='aluno_termo_fisico_eventos' and c.relkind='r') ok
  union all select 'RLS ligada na tabela',
         coalesce((select relrowsecurity from pg_class where oid='public.aluno_termo_fisico_eventos'::regclass), false)
  union all select 'policy de SELECT para gestão existe',
         exists (select 1 from pg_policy where polrelid='public.aluno_termo_fisico_eventos'::regclass
                  and polname='aluno_termo_fisico_eventos_gestao_le' and polcmd='r')
  union all select 'sem nenhuma policy de escrita para authenticated',
         not exists (select 1 from pg_policy where polrelid='public.aluno_termo_fisico_eventos'::regclass
                      and polcmd in ('a','w','d'))
  union all select 'anon sem privilégio algum na tabela',
         not (has_table_privilege('anon','public.aluno_termo_fisico_eventos','SELECT')
           or has_table_privilege('anon','public.aluno_termo_fisico_eventos','INSERT')
           or has_table_privilege('anon','public.aluno_termo_fisico_eventos','UPDATE')
           or has_table_privilege('anon','public.aluno_termo_fisico_eventos','DELETE')
           or has_table_privilege('anon','public.aluno_termo_fisico_eventos','TRUNCATE'))
  union all select 'service_role sem privilégio algum na tabela',
         not (has_table_privilege('service_role','public.aluno_termo_fisico_eventos','SELECT')
           or has_table_privilege('service_role','public.aluno_termo_fisico_eventos','INSERT')
           or has_table_privilege('service_role','public.aluno_termo_fisico_eventos','UPDATE')
           or has_table_privilege('service_role','public.aluno_termo_fisico_eventos','DELETE')
           or has_table_privilege('service_role','public.aluno_termo_fisico_eventos','TRUNCATE'))
  union all select 'authenticated sem INSERT/UPDATE/DELETE/TRUNCATE na tabela',
         not (has_table_privilege('authenticated','public.aluno_termo_fisico_eventos','INSERT')
           or has_table_privilege('authenticated','public.aluno_termo_fisico_eventos','UPDATE')
           or has_table_privilege('authenticated','public.aluno_termo_fisico_eventos','DELETE')
           or has_table_privilege('authenticated','public.aluno_termo_fisico_eventos','TRUNCATE'))
  union all select 'PUBLIC sem entrada na ACL da tabela',
         not exists (select 1 from aclexplode((select relacl from pg_class where oid='public.aluno_termo_fisico_eventos'::regclass)) a where a.grantee = 0)
  union all select 'RPC de leitura existe, SECURITY DEFINER, search_path fixo',
         exists (select 1 from pg_proc where oid='public.termo_fisico_ler(text)'::regprocedure
                  and prosecdef and proconfig is not null and array_to_string(proconfig, ',') like '%search_path=public%')
  union all select 'RPC de registro existe, SECURITY DEFINER, search_path fixo',
         exists (select 1 from pg_proc where oid='public.termo_fisico_registrar(text,text,boolean)'::regprocedure
                  and prosecdef and proconfig is not null and array_to_string(proconfig, ',') like '%search_path=public%')
  union all select 'EXECUTE: authenticated sim, anon/PUBLIC/service_role não',
         has_function_privilege('authenticated','public.termo_fisico_registrar(text,text,boolean)','EXECUTE')
         and not has_function_privilege('anon','public.termo_fisico_registrar(text,text,boolean)','EXECUTE')
         and not has_function_privilege('service_role','public.termo_fisico_registrar(text,text,boolean)','EXECUTE')
         and not exists (select 1 from aclexplode((select proacl from pg_proc where oid='public.termo_fisico_registrar(text,text,boolean)'::regprocedure)) a where a.grantee = 0)
  union all select 'triggers de imutabilidade ativas (linha e instrução)',
         (select count(*) from pg_trigger t where t.tgrelid='public.aluno_termo_fisico_eventos'::regclass
            and not t.tgisinternal and t.tgname in ('aluno_termo_fisico_eventos_sem_update_delete','aluno_termo_fisico_eventos_sem_truncate')) = 2
  union all select 'índice do aluno existe',
         exists (select 1 from pg_indexes where schemaname='public' and tablename='aluno_termo_fisico_eventos'
                  and indexname='aluno_termo_fisico_eventos_aluno_idx')
  union all select 'nenhum nome de rollback residual (descartada ausente ou protegida)',
         not exists (select 1 from pg_class c where c.relname='aluno_termo_fisico_eventos_descartada_20261113'
                       and c.relkind='r'
                       and has_table_privilege('authenticated', c.oid, 'SELECT'))
  union all select 'notificacoes: sem alteração de estrutura pela migration (tipo sem CHECK)',
         not exists (select 1 from pg_constraint where conrelid='public.notificacoes'::regclass and contype='c'
                       and pg_get_constraintdef(oid) like '%tipo%')
  union all select 'mesclar_aluno_duplicado: ainda existe (efeito conhecido: recusa com termo, decisão B)',
         exists (select 1 from pg_proc where proname='mesclar_aluno_duplicado')
)
select item, ok from itens order by item;
