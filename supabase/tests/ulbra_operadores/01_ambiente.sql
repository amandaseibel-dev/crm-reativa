-- AMBIENTE ISOLADO — mapeamento operador ReATIVA x atendente ULBRA.
--
-- Postgres descartavel do CI. NAO fala com producao, NAO usa segredo, NAO toca
-- em objeto real.
--
-- REPRODUZ DE PROPOSITO a armadilha do projeto:
--   `alter default privileges ... grant all on tables to authenticated`
-- que faz TABELA NOVA nascer aberta para `authenticated`, TRUNCATE incluso --
-- e TRUNCATE a RLS nao cobre. Sem isso, o `revoke all` da migration passaria
-- sem exercitar nada e o teste daria verde sem provar coisa alguma.

\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon;          end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role;  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

-- auth.jwt() de mentira, lendo de GUC, como nos demais testes do repositorio.
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select jsonb_build_object('email', coalesce(current_setting('teste.email', true), ''));
$$;

-- COPIA DA DEFINICAO REAL DE PRODUCAO, lida por pg_get_functiondef em
-- ahattpqrjmhkzsmnbdzs em 08/11/2026: lista fixa de tres e-mails, nao consulta
-- `usuarios`. A migration depende desta funcao para a policy.
create or replace function public.usuario_e_gestao() returns boolean
language sql stable security definer set search_path = public as $$
  select lower(coalesce(auth.jwt()->>'email','')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
$$;

create or replace function public.afirmar(condicao boolean, descricao text) returns void
language plpgsql as $$
begin
  if not coalesce(condicao, false) then
    raise exception 'FALHOU: %', descricao;
  end if;
  raise notice 'ok: %', descricao;
end;
$$;
