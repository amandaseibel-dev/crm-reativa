-- Casos DEPOIS de aplicar a migration 20261108130000.
\set ON_ERROR_STOP on

-- 1. O revoke entrou no corpo
do $$
declare v boolean;
begin
  select position('revoke truncate' in lower(p.prosrc)) > 0 into v
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='acordos_pos_importacao';
  if not v then raise exception 'caso 1 FALHOU: revoke nao esta no corpo'; end if;
  raise notice 'caso 1 OK: revoke truncate presente no corpo';
end
$$;

-- 2. A função ficou inteira: DEFAULT dos argumentos, SECURITY DEFINER, SET e
--    os três EXECUTE -- é o que a premissa §10 manda reconferir
do $$
declare v_cfg text; v_args text; v_acl text; v_secdef boolean; v_ret text;
begin
  select array_to_string(p.proconfig, ', '), pg_get_function_arguments(p.oid),
         (select string_agg(x.grantee::regrole::text||':'||x.privilege_type, ', ' order by x.grantee::regrole::text)
            from aclexplode(p.proacl) x),
         p.prosecdef, pg_get_function_result(p.oid)
    into v_cfg, v_args, v_acl, v_secdef, v_ret
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='acordos_pos_importacao';

  if v_cfg is distinct from 'search_path=public, statement_timeout=600s' then
    raise exception 'caso 2 FALHOU: config [%]', v_cfg;
  end if;
  if position('DEFAULT NULL::uuid' in v_args) = 0 or position('DEFAULT false' in v_args) = 0 then
    raise exception 'caso 2 FALHOU: DEFAULT perdido [%]', v_args;
  end if;
  if v_acl is distinct from 'authenticated:EXECUTE, postgres:EXECUTE, service_role:EXECUTE' then
    raise exception 'caso 2 FALHOU: EXECUTE mudou [%]', v_acl;
  end if;
  if not v_secdef then raise exception 'caso 2 FALHOU: perdeu SECURITY DEFINER'; end if;
  if v_ret <> 'jsonb' then raise exception 'caso 2 FALHOU: retorno [%]', v_ret; end if;

  raise notice 'caso 2 OK: % / % / SECURITY DEFINER / retorno %', v_args, v_cfg, v_ret;
end
$$;

-- 3. O BURACO FECHOU: a tabela criada agora nasce SEM TRUNCATE para
--    authenticated, mantendo RLS e os outros privilégios
do $$
declare v_tab text; v_acl text; v_rls boolean; v_erro text; v_linhas integer;
begin
  -- `v_lote` e to_char(clock_timestamp(),'YYYYMMDDHH24MISS'): granularidade de
  -- UM SEGUNDO. Duas chamadas no mesmo segundo geram o MESMO nome, e o
  -- `create table if not exists` reusa a tabela anterior em vez de criar.
  -- Em producao ha minutos ou horas entre execucoes; no CI, milissegundos.
  -- Por isso espera o segundo virar, e recusa seguir se ainda colidir.
  perform pg_sleep(1.1);
  select (public.acordos_pos_importacao(null, true) ->> 'backup') into v_tab;

  if exists (select 1 from public._teste_tabela_do_baseline b where b.nome = v_tab) then
    raise exception 'INCONCLUSIVO: a funcao reusou a tabela do baseline (%) -- colisao de lote de 1s, nao defeito da migration', v_tab;
  end if;


  select (select a::text from unnest(relacl) a where a::text like 'authenticated=%'), relrowsecurity
    into v_acl, v_rls
    from pg_class where oid = ('public.'||quote_ident(v_tab))::regclass;

  if position('D' in split_part(v_acl,'/',1)) > 0 then
    raise exception 'caso 3 FALHOU: tabela nova ainda nasce com TRUNCATE (%)', v_acl;
  end if;
  if not v_rls then
    raise exception 'caso 3 FALHOU: tabela nova sem RLS';
  end if;
  if not (has_table_privilege('authenticated', ('public.'||quote_ident(v_tab))::regclass::oid, 'SELECT')
      and has_table_privilege('authenticated', ('public.'||quote_ident(v_tab))::regclass::oid, 'INSERT')
      and has_table_privilege('authenticated', ('public.'||quote_ident(v_tab))::regclass::oid, 'UPDATE')
      and has_table_privilege('authenticated', ('public.'||quote_ident(v_tab))::regclass::oid, 'DELETE')) then
    raise exception 'caso 3 FALHOU: o patch levou privilegio fora do alvo (%)', v_acl;
  end if;

  -- e o TRUNCATE agora e negado
  set local role authenticated;
  begin
    execute format('truncate table public.%I', v_tab);
  exception when insufficient_privilege then
    v_erro := sqlstate;
  end;
  reset role;

  if v_erro is distinct from '42501' then
    raise exception 'caso 3 FALHOU: TRUNCATE nao foi negado (sqlstate=%)', coalesce(v_erro,'sem erro');
  end if;

  execute format('select count(*) from public.%I', v_tab) into v_linhas;
  if v_linhas = 0 then
    raise exception 'caso 3 FALHOU: a tabela foi esvaziada';
  end if;

  raise notice 'caso 3 OK: tabela nova nasce com %, RLS ligada, TRUNCATE negado (42501), % linhas intactas', v_acl, v_linhas;
end
$$;

-- 4. ALCANCE: a tabela criada ANTES do patch segue como estava -- esta
--    migration nao mexe em tabela existente (isso e o PR das 545)
do $$
declare v_tab text; v_acl text;
begin
  select nome into v_tab from public._teste_tabela_do_baseline;
  select (select a::text from unnest(relacl) a where a::text like 'authenticated=%')
    into v_acl from pg_class where oid = ('public.'||quote_ident(v_tab))::regclass;

  if position('D' in split_part(v_acl,'/',1)) = 0 then
    raise exception 'caso 4 FALHOU: o patch mexeu na tabela anterior (%) -- alcance maior que o declarado', v_acl;
  end if;
  raise notice 'caso 4 OK: tabela anterior % intacta, segue com % (alcance minimo respeitado)', v_tab, v_acl;
end
$$;

-- 5. ALCANCE: o default privilege do schema NAO foi alterado -- uma tabela
--    criada fora da funcao continua nascendo com TRUNCATE
do $$
declare v_acl text;
begin
  create table public._teste_fora_da_funcao (id int);
  select (select a::text from unnest(relacl) a where a::text like 'authenticated=%')
    into v_acl from pg_class where oid = 'public._teste_fora_da_funcao'::regclass;

  if position('D' in split_part(v_acl,'/',1)) = 0 then
    raise exception 'caso 5 FALHOU: o default privilege do schema foi alterado (%) -- alcance global, nao era o pedido', v_acl;
  end if;
  drop table public._teste_fora_da_funcao;
  raise notice 'caso 5 OK: default do schema intacto -- o patch nao tem alcance global';
end
$$;

-- 6. anon continua sem alcance
do $$
declare v_tab text; v_v boolean;
begin
  perform pg_sleep(1.1);   -- lote de 1s: evita reusar a tabela do caso anterior
  select (public.acordos_pos_importacao(null, true) ->> 'backup') into v_tab;
  select has_table_privilege('anon', ('public.'||quote_ident(v_tab))::regclass::oid, 'SELECT')
      or has_table_privilege('anon', ('public.'||quote_ident(v_tab))::regclass::oid, 'TRUNCATE')
    into v_v;
  if v_v then raise exception 'caso 6 FALHOU: anon alcanca a tabela nova'; end if;
  raise notice 'caso 6 OK: anon sem alcance na tabela nova';
end
$$;

-- 7. O portão interno continua barrando quem não é gestão
do $$
declare v_erro text;
begin
  create or replace function public.usuario_e_gestao() returns boolean
    language sql stable security definer set search_path = public as $g$ select false $g$;
  begin
    perform public.acordos_pos_importacao(null, true);
  exception when insufficient_privilege then
    v_erro := sqlstate;
  end;
  create or replace function public.usuario_e_gestao() returns boolean
    language sql stable security definer set search_path = public as $g$ select true $g$;

  if v_erro is distinct from '42501' then
    raise exception 'caso 7 FALHOU: portao interno nao barrou (sqlstate=%)', coalesce(v_erro,'sem erro');
  end if;
  raise notice 'caso 7 OK: portao interno barra quem nao e gestao (42501)';
end
$$;
