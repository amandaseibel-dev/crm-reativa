-- AMBIENTE ISOLADO — etapa 1 da Mensageria ULBRA (recebimento).
--
-- Roda num Postgres 16 descartavel do CI. NAO fala com producao, NAO usa
-- segredo, NAO toca em nenhum objeto real.
--
-- LIMITE HONESTO: `app_email`, `app_usuario_ativo`, `eh_painel` e
-- `usuario_e_gestao` aqui sao STUBS que reproduzem o CONTRATO (lem o email de
-- uma GUC e consultam `usuarios`). As definicoes reais de producao podem
-- divergir; por isso, antes de confiar, conferir no banco real:
--     select pg_get_functiondef('public.usuario_e_gestao()'::regprocedure);
--
-- O QUE REPRODUZ DE PROPOSITO:
--   - `alter default privileges ... grant all on tables to authenticated`:
--     a armadilha que faz tabela nova nascer aberta para authenticated,
--     inclusive TRUNCATE, que RLS nao cobre. Sem isso o REVOKE da migration
--     passaria sem exercitar nada.

\set ON_ERROR_STOP on

-- 1. PAPEIS -----------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon;          end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role;  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

-- 2. AUTH (stub de JWT e uid lidos de GUC) ----------------------------------
create schema if not exists auth;
-- No Supabase real, anon/authenticated tem USAGE em auth e EXECUTE em auth.jwt().
grant usage on schema auth to anon, authenticated, service_role;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select jsonb_build_object('email', coalesce(current_setting('teste.email', true), ''));
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('teste.uid', true), '')::uuid;
$$;

-- 3. TABELAS QUE A MIGRATION REFERENCIA ---------------------------------------
create table public.alunos (id uuid primary key default gen_random_uuid(), nome text);
create table public.usuarios (
  id uuid primary key default gen_random_uuid(),
  email text not null unique, ativo boolean not null default true
);
create table public.casos (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid references public.alunos (id),
  operador_email text
);

-- 4. FUNCOES DE SEGURANCA: COPIA DAS DEFINICOES REAIS DE PRODUCAO --------------
-- Lidas de pg_get_functiondef em ahattpqrjmhkzsmnbdzs em 08/11/2026. As
-- diferencas em relacao a um stub seriam exatamente o que o teste precisa pegar:
-- usuario_e_gestao() NAO consulta usuarios; e uma lista fixa de tres e-mails.
create or replace function public.app_email() returns text
language sql stable set search_path = public as $$
  select lower(coalesce((auth.jwt() ->> 'email'), ''));
$$;

create or replace function public.app_usuario_ativo() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.usuarios u
    where lower(u.email) = lower(coalesce((auth.jwt() ->> 'email'), ''))
      and u.ativo is true
  );
$$;

create or replace function public.eh_painel() returns boolean
language sql stable security definer set search_path = public as $$
  SELECT coalesce(
    (SELECT lower(u.email) = 'painel.tv@reativa.local'
       FROM public.usuarios u
      WHERE u.id = auth.uid()),
    false);
$$;

create or replace function public.usuario_e_gestao() returns boolean
language sql stable security definer set search_path = public as $$
  select lower(coalesce(auth.jwt()->>'email','')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
$$;

-- 5. AFIRMACAO: falha alto, com o nome do caso --------------------------------
create or replace function public.afirmar(condicao boolean, descricao text) returns void
language plpgsql as $$
begin
  if not coalesce(condicao, false) then
    raise exception 'FALHOU: %', descricao;
  end if;
  raise notice 'ok: %', descricao;
end;
$$;

-- 6. DADOS: 3 alunos, 3 operadores/gestao, casos e atendimentos -------------
insert into public.alunos (id, nome) values
  ('00000000-0000-0000-0000-00000000000a', 'Aluno A'),
  ('00000000-0000-0000-0000-00000000000b', 'Aluno B'),
  ('00000000-0000-0000-0000-00000000000c', 'Aluno C');

insert into public.usuarios (id, email, ativo) values
  ('00000000-0000-0000-0000-0000000000a1', 'op1@x', true),
  ('00000000-0000-0000-0000-0000000000a2', 'op2@x', true),
  ('00000000-0000-0000-0000-0000000000a3', 'amanda.seibel@aelbra.com.br', true),
  ('00000000-0000-0000-0000-0000000000a4', 'inativo@x', false),
  ('00000000-0000-0000-0000-0000000000a5', 'painel.tv@reativa.local', true);

-- A tem caso com op1; B tem caso com op2; C nao tem caso.
insert into public.casos (aluno_id, operador_email) values
  ('00000000-0000-0000-0000-00000000000a', 'op1@x'),
  ('00000000-0000-0000-0000-00000000000b', 'op2@x');
