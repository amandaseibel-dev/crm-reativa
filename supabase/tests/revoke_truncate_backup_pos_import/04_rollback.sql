-- Casos DEPOIS de aplicar o rollback. Prova que o estado volta ao original.
\set ON_ERROR_STOP on

-- 1. As 545 voltaram a ter TRUNCATE; as 3 continuam de fora
do $$
declare v_com integer; v_sem integer;
begin
  select count(*) filter (where has_table_privilege('authenticated', c.oid, 'TRUNCATE')),
         count(*) filter (where not has_table_privilege('authenticated', c.oid, 'TRUNCATE'))
    into v_com, v_sem
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname like '\_backup\_pos\_import\_%';

  if v_com <> 545 then raise exception 'rollback 1 FALHOU: % com TRUNCATE (esperado 545)', v_com; end if;
  if v_sem <> 3   then raise exception 'rollback 1 FALHOU: % sem TRUNCATE (esperado 3)', v_sem; end if;
  raise notice 'rollback 1 OK: 545 com TRUNCATE, 3 sem -- estado original';
end
$$;

-- 2. A assinatura do conjunto volta a ser a de produção
do $$
declare v_md5 text;
begin
  select md5(string_agg(c.relname, ',' order by c.relname)) into v_md5
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname like '\_backup\_pos\_import\_%'
     and has_table_privilege('authenticated', c.oid, 'TRUNCATE');
  if v_md5 <> 'e9368e7cd2d8095423234387ace01018' then
    raise exception 'rollback 2 FALHOU: md5 % apos rollback', v_md5;
  end if;
  raise notice 'rollback 2 OK: assinatura de volta em e9368e7cd2d8095423234387ace01018';
end
$$;

-- 3. RLS segue intacta -- o rollback também não mexe em RLS
do $$
declare v integer;
begin
  select count(*) into v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname like '\_backup\_pos\_import\_%'
     and c.relrowsecurity;
  if v <> 548 then raise exception 'rollback 3 FALHOU: % com RLS (esperado 548)', v; end if;
  raise notice 'rollback 3 OK: 548 com RLS';
end
$$;
