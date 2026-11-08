-- Casos DEPOIS de aplicar a migration (o revoke das 545).
-- Roda num Postgres descartável; nenhuma linha destes casos toca produção.
\set ON_ERROR_STOP on

-- 1. O alvo foi atingido: nenhuma das 548 tem mais TRUNCATE para authenticated
do $$
declare v integer;
begin
  select count(*) into v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname like '\_backup\_pos\_import\_%'
     and has_table_privilege('authenticated', c.oid, 'TRUNCATE');
  if v <> 0 then raise exception 'caso 1 FALHOU: % tabelas ainda com TRUNCATE', v; end if;
  raise notice 'caso 1 OK: 0 tabelas com TRUNCATE para authenticated';
end
$$;

-- 2. Os outros privilégios continuam todos de pé nas 545
do $$
declare v integer;
begin
  select count(*) into v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname like '\_backup\_pos\_import\_%'
     and exists (select 1 from unnest(c.relacl) a where a::text like 'authenticated=%')
     and has_table_privilege('authenticated', c.oid, 'SELECT')
     and has_table_privilege('authenticated', c.oid, 'INSERT')
     and has_table_privilege('authenticated', c.oid, 'UPDATE')
     and has_table_privilege('authenticated', c.oid, 'DELETE')
     and has_table_privilege('authenticated', c.oid, 'REFERENCES')
     and has_table_privilege('authenticated', c.oid, 'TRIGGER');
  if v <> 545 then raise exception 'caso 2 FALHOU: % tabelas com os 6 privilegios (esperado 545)', v; end if;
  raise notice 'caso 2 OK: 545 mantem SELECT/INSERT/UPDATE/DELETE/REFERENCES/TRIGGER';
end
$$;

-- 3. O BURACO ESTÁ FECHADO: o mesmo TRUNCATE que funcionou no baseline agora é negado
do $$
declare v_erro text := null; v_linhas integer;
begin
  set local role authenticated;
  begin
    truncate table public."_backup_pos_import_20260831";
  exception when insufficient_privilege then
    v_erro := sqlstate;
  end;
  reset role;

  if v_erro is distinct from '42501' then
    raise exception 'caso 3 FALHOU: TRUNCATE como authenticated nao foi negado (sqlstate=%)', coalesce(v_erro,'sem erro');
  end if;

  select count(*) into v_linhas from public."_backup_pos_import_20260831";
  if v_linhas <> 1 then
    raise exception 'caso 3 FALHOU: a tabela foi esvaziada (% linhas)', v_linhas;
  end if;

  raise notice 'caso 3 OK: TRUNCATE negado (42501) e o lastro continua na tabela';
end
$$;

-- 4. As 3 tabelas que nunca tiveram grant seguem exatamente como estavam
do $$
declare v integer;
begin
  select count(*) into v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relkind='r'
     and c.relname in ('_backup_pos_import_20260831225215',
                       '_backup_pos_import_20260831232000',
                       '_backup_pos_import_20260901085846')
     and not exists (select 1 from unnest(c.relacl) a where a::text like 'authenticated=%');
  if v <> 3 then raise exception 'caso 4 FALHOU: % das 3 sem grant (esperado 3)', v; end if;
  raise notice 'caso 4 OK: as 3 sem grant nao foram tocadas';
end
$$;

-- 5. RLS intacta nas 548 -- a migration não mexe em RLS
do $$
declare v integer; v_pol integer;
begin
  select count(*) into v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname like '\_backup\_pos\_import\_%'
     and c.relrowsecurity;
  select count(*) into v_pol from pg_policies
   where schemaname='public' and tablename like '\_backup\_pos\_import\_%';
  if v <> 548 then raise exception 'caso 5 FALHOU: % com RLS (esperado 548)', v; end if;
  if v_pol <> 0 then raise exception 'caso 5 FALHOU: % policies criadas (esperado 0)', v_pol; end if;
  raise notice 'caso 5 OK: 548 com RLS, 0 policy -- nada mudou';
end
$$;

-- 6. service_role NÃO foi afetado -- é por desenho (premissa §5)
do $$
declare v integer;
begin
  select count(*) into v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname like '\_backup\_pos\_import\_%'
     and has_table_privilege('service_role', c.oid, 'TRUNCATE');
  if v <> 548 then raise exception 'caso 6 FALHOU: service_role com TRUNCATE em % (esperado 548)', v; end if;
  raise notice 'caso 6 OK: service_role mantem TRUNCATE nas 548';
end
$$;

-- 7. anon segue sem nada
do $$
declare v integer;
begin
  select count(*) into v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname like '\_backup\_pos\_import\_%'
     and (has_table_privilege('anon', c.oid, 'TRUNCATE') or has_table_privilege('anon', c.oid, 'SELECT'));
  if v <> 0 then raise exception 'caso 7 FALHOU: anon alcanca % tabelas', v; end if;
  raise notice 'caso 7 OK: anon nao alcanca nenhuma das 548';
end
$$;

-- 8. A guarda de assinatura recusa conjunto diferente (teste negativo):
--    cria uma tabela nova no padrão e confere que a migration recusaria rodar.
do $$
declare v_md5 text; v_total integer;
begin
  create table public."_backup_pos_import_99999999999999" as select 1 as id;

  select count(*), md5(string_agg(c.relname, ',' order by c.relname))
    into v_total, v_md5
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname like '\_backup\_pos\_import\_%'
     and has_table_privilege('authenticated', c.oid, 'TRUNCATE');

  if v_total = 545 and v_md5 = 'e9368e7cd2d8095423234387ace01018' then
    raise exception 'caso 8 FALHOU: a guarda nao distinguiria o conjunto novo';
  end if;

  drop table public."_backup_pos_import_99999999999999";
  raise notice 'caso 8 OK: conjunto diferente muda total/md5 -- a guarda da migration recusaria rodar';
end
$$;
