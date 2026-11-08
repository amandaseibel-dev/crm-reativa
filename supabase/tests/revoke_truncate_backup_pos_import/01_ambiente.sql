-- Ambiente mínimo do Supabase num Postgres descartável do CI.
-- Reproduz o que importa para esta migration: os três papéis, NOLOGIN como em
-- produção, e o DEFAULT PRIVILEGE do schema `public` que é a causa raiz --
-- toda tabela criada ali nasce com TRUNCATE para `authenticated`.
\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

-- A causa raiz, reproduzida: é isto que dá o `D` (TRUNCATE) de graça.
alter default privileges in schema public
  grant all on tables to authenticated, service_role;

-- Prova de que o ambiente está fiel ao de produção.
do $$
declare v_acl text;
begin
  create table public._fidelidade_do_ambiente (id int);
  select (select a::text from unnest(relacl) a where a::text like 'authenticated=%')
    into v_acl from pg_class where oid = 'public._fidelidade_do_ambiente'::regclass;

  if v_acl is null or position('D' in split_part(v_acl, '/', 1)) = 0 then
    raise exception 'ambiente infiel: tabela nova nao herdou TRUNCATE para authenticated (acl=%)', v_acl;
  end if;

  raise notice 'ambiente fiel: tabela nova nasce com % -- contem D (TRUNCATE)', v_acl;
  drop table public._fidelidade_do_ambiente;
end
$$;
