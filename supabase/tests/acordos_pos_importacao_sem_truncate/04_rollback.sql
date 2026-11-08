-- Casos DEPOIS do rollback: a função volta ao comportamento anterior.
\set ON_ERROR_STOP on

-- 1. O revoke saiu do corpo e a função segue inteira
do $$
declare v_tem boolean; v_cfg text; v_args text; v_acl text; v_secdef boolean;
begin
  select position('revoke truncate' in lower(p.prosrc)) > 0,
         array_to_string(p.proconfig, ', '), pg_get_function_arguments(p.oid),
         (select string_agg(x.grantee::regrole::text||':'||x.privilege_type, ', ' order by x.grantee::regrole::text)
            from aclexplode(p.proacl) x),
         p.prosecdef
    into v_tem, v_cfg, v_args, v_acl, v_secdef
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='acordos_pos_importacao';

  if v_tem then raise exception 'rollback 1 FALHOU: revoke continua no corpo'; end if;
  if v_cfg is distinct from 'search_path=public, statement_timeout=600s' then
    raise exception 'rollback 1 FALHOU: config [%]', v_cfg;
  end if;
  if position('DEFAULT NULL::uuid' in v_args) = 0 or position('DEFAULT false' in v_args) = 0 then
    raise exception 'rollback 1 FALHOU: DEFAULT perdido [%]', v_args;
  end if;
  if v_acl is distinct from 'authenticated:EXECUTE, postgres:EXECUTE, service_role:EXECUTE' then
    raise exception 'rollback 1 FALHOU: EXECUTE mudou [%]', v_acl;
  end if;
  if not v_secdef then raise exception 'rollback 1 FALHOU: perdeu SECURITY DEFINER'; end if;

  raise notice 'rollback 1 OK: corpo sem revoke, % / % / SECURITY DEFINER', v_args, v_cfg;
end
$$;

-- 2. E o comportamento volta mesmo: tabela nova nasce COM TRUNCATE outra vez.
--    É o preço do rollback, e está dito no cabeçalho do arquivo.
do $$
declare v_tab text; v_acl text;
begin
  select (public.acordos_pos_importacao(null, true) ->> 'backup') into v_tab;
  select (select a::text from unnest(relacl) a where a::text like 'authenticated=%')
    into v_acl from pg_class where oid = ('public.'||quote_ident(v_tab))::regclass;

  if position('D' in split_part(v_acl,'/',1)) = 0 then
    raise exception 'rollback 2 FALHOU: tabela nova nasceu sem TRUNCATE -- o rollback nao reverteu o comportamento (%)', v_acl;
  end if;
  raise notice 'rollback 2 OK: comportamento revertido, tabela nova nasce com % (buraco reaberto, como esperado)', v_acl;
end
$$;
