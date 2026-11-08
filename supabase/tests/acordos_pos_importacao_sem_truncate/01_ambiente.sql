-- Ambiente mínimo num Postgres descartável do CI.
-- Reproduz os três papéis e, principalmente, a CAUSA RAIZ: o default privilege
-- do schema `public`, que dá TRUNCATE a `authenticated` em toda tabela nova.
\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public
  grant all on tables to authenticated, service_role;

-- Portão interno, como em produção (a Guarda 3 da migration exige que o nome
-- `usuario_e_gestao` continue no corpo da função).
create or replace function public.usuario_e_gestao() returns boolean
  language sql stable security definer set search_path = public
  as $$ select true $$;

-- Tabela de origem mínima, só para a função ter de onde copiar.
create table public.acordos_titulos (
  id bigint generated always as identity primary key,
  documento text,
  situacao  text,
  valor     numeric
);
insert into public.acordos_titulos (documento, situacao, valor)
values ('000000000001','ABERTO', 10.00), ('000000000002','ABERTO', 20.00);

-- Confere que o ambiente é fiel: tabela nova nasce com o `D`.
do $$
declare v_acl text;
begin
  create table public._fidelidade (id int);
  select (select a::text from unnest(relacl) a where a::text like 'authenticated=%')
    into v_acl from pg_class where oid = 'public._fidelidade'::regclass;
  if v_acl is null or position('D' in split_part(v_acl,'/',1)) = 0 then
    raise exception 'ambiente infiel: tabela nova nao herdou TRUNCATE (acl=%)', v_acl;
  end if;
  raise notice 'ambiente fiel: tabela nova nasce com % -- contem D (TRUNCATE)', v_acl;
  drop table public._fidelidade;
end
$$;
