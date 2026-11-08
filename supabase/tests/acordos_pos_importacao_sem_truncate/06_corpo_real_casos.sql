-- Depois da migration, sobre o CORPO REAL. Sete conferências.
\set ON_ERROR_STOP on

do $casos$
declare
  v_def     text;
  v_antes   text;
  v_linhas  int;
  v_acl     text;
  v_args    text;
  v_ret     text;
  v_cfg     text;
  v_secdef  boolean;
  v_ancora constant text :=
    'execute format(''alter table public.%I enable row level security'', ''_backup_pos_import_'' || v_lote);';
  v_n int;
begin
  select pg_get_functiondef(p.oid), p.prosecdef,
         array_to_string(p.proconfig, ', '),
         pg_get_function_arguments(p.oid),
         pg_get_function_result(p.oid),
         (select string_agg(x.grantee::regrole::text || '=' || x.privilege_type, ', '
                            order by x.grantee::regrole::text)
            from aclexplode(p.proacl) x)
    into v_def, v_secdef, v_cfg, v_args, v_ret, v_acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'acordos_pos_importacao';

  select md5 into v_antes from public._prova_corpo_real where etapa = 'antes';

  -- 1. o revoke entrou
  if position('revoke truncate on table public.%I from authenticated' in v_def) = 0 then
    raise exception '1 FALHOU: o revoke nao esta no corpo depois da migration';
  end if;

  -- 2. e entrou DEPOIS da âncora, não em outro lugar
  if position(v_ancora in v_def) = 0
     or position('revoke truncate' in v_def) < position(v_ancora in v_def) then
    raise exception '2 FALHOU: o revoke nao ficou depois da ancora';
  end if;

  -- 3. a âncora segue única (o patch não a duplicou)
  v_n := (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora);
  if v_n <> 1 then
    raise exception '3 FALHOU: ancora aparece % vez(es), esperado 1', v_n;
  end if;

  -- 4. SECURITY DEFINER, SET e assinatura intactos
  if not v_secdef then
    raise exception '4 FALHOU: perdeu SECURITY DEFINER';
  end if;
  if v_cfg <> 'search_path=public, statement_timeout=600s' then
    raise exception '4 FALHOU: proconfig mudou: [%]', v_cfg;
  end if;
  if v_args <> 'p_importacao_id uuid DEFAULT NULL::uuid, p_confirmar boolean DEFAULT false' then
    raise exception '4 FALHOU: argumentos/DEFAULT mudaram: [%]', v_args;
  end if;
  if v_ret <> 'jsonb' then
    raise exception '4 FALHOU: retorno mudou: [%]', v_ret;
  end if;

  -- 5. o ACL de EXECUTE não mudou -- nem ganhou PUBLIC
  if v_acl is distinct from 'authenticated=EXECUTE, postgres=EXECUTE, service_role=EXECUTE' then
    raise exception '5 FALHOU: ACL de EXECUTE mudou: [%]', v_acl;
  end if;

  -- 6. cresceu exatamente 3 linhas (dois comentários + o execute format)
  v_linhas := (select count(*) from regexp_split_to_table(v_def, E'\n'));
  if v_linhas <> 104 then
    raise exception '6 FALHOU: corpo tem % linhas, esperado 104 (101 + 3)', v_linhas;
  end if;

  -- 7. o texto mudou de verdade (e guarda o md5 do estado aplicado)
  if md5(v_def) = v_antes then
    raise exception '7 FALHOU: o corpo nao mudou (md5 igual ao de antes)';
  end if;
  insert into public._prova_corpo_real (etapa, md5, bytes)
  values ('depois', md5(v_def), length(v_def))
  on conflict (etapa) do update set md5 = excluded.md5, bytes = excluded.bytes;

  raise notice 'OK 7/7 sobre o corpo real -- md5 depois %, % linhas, % bytes',
    md5(v_def), v_linhas, length(v_def);
end
$casos$;
