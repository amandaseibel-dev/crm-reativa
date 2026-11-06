-- AMBIENTE ISOLADO — trava de tabulação somente gestão no banco
-- (20261106140000_tabulacao_so_gestao_no_banco)
--
-- Roda num Postgres 16 descartável do CI (serviço do GitHub Actions).
-- NAO fala com produção, NAO usa segredo, NAO tem dado de aluno real.
--
-- O QUE ESTE ARQUIVO CRIA:
--   1. Papéis Supabase (anon, authenticated, service_role).
--   2. Stubs de auth.jwt() e auth.role() lidos de GUC -- é assim que se troca
--      de usuário no teste, e é o que prova que a autorização vem do TOKEN e
--      não de parâmetro de quem chama.
--   3. `public.usuario_e_gestao()`, cópia fiel do corpo de produção
--      (06/11/2026): os três e-mails de gestão, lidos do JWT.
--   4. `public.tabulacoes` com as colunas que a trava usa, semeada com o
--      catálogo de produção no que importa: os 7 `somente_gestao` + comuns.
--   5. `public.alunos` mínima -- só as três colunas de status que o gatilho
--      vigia, mais id e nome.
--
-- O QUE ESTE ARQUIVO NAO CRIA, DE PROPOSITO: a tabulação RETORNO_FINANCEIRO.
-- Ela é semeada em 03_casos, para que o teste prove também que a trava passa a
-- valer a partir da linha no catálogo -- sem migration nova.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. PAPÉIS
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')           then create role anon;          end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated')  then create role authenticated;  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')   then create role service_role;   end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. STUBS auth -- a identidade vem do "token", nunca de argumento
-- ---------------------------------------------------------------------------
create schema if not exists auth;

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select case
           when coalesce(current_setting('teste.email', true), '') = '' then null
           else jsonb_build_object('email', current_setting('teste.email', true))
         end;
$$;

create or replace function auth.role() returns text language sql stable as $$
  select coalesce(current_setting('teste.role', true), 'authenticated');
$$;

-- ---------------------------------------------------------------------------
-- 3. usuario_e_gestao() -- corpo fiel ao de produção em 06/11/2026
-- ---------------------------------------------------------------------------
create or replace function public.usuario_e_gestao()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select lower(coalesce(auth.jwt()->>'email','')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. CATÁLOGO -- só as colunas que a trava lê, com as mesmas regras de forma
-- ---------------------------------------------------------------------------
create table if not exists public.tabulacoes (
  codigo         text primary key,
  rotulo         text not null,
  ativa          boolean not null default true,
  ordem          integer not null default 500,
  grupo          text not null default 'CONTATO',
  retorno_modo   text not null default 'NENHUM',
  retorno_dias_uteis integer,
  proxima_acao   text not null default 'CONTATAR',
  somente_gestao boolean not null default false,
  sistema        boolean not null default false,
  bloqueia_acionamento boolean not null default false,
  exige_processo  boolean not null default false,
  efeito_desfecho text,
  constraint tabulacoes_codigo_formato check (codigo ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  constraint tabulacoes_grupo_valido check (grupo = any (array['CONTATO','LINK','TERMO','FINANCEIRO','ENCERRAMENTO','ALEGACAO'])),
  constraint tabulacoes_retorno_modo_valido check (retorno_modo = any (array['NENHUM','MANUAL','DIAS_UTEIS'])),
  constraint tabulacoes_retorno_coerente check (
    (retorno_modo = 'DIAS_UTEIS' and retorno_dias_uteis between 0 and 365)
    or (retorno_modo <> 'DIAS_UTEIS' and retorno_dias_uteis is null)
  )
);

-- RLS ligada como em produção, e SEM force: é exatamente essa combinação que
-- permite ao gatilho (SECURITY DEFINER, dona da tabela) ler as linhas
-- `somente_gestao` que a policy esconde do operador.
alter table public.tabulacoes enable row level security;

drop policy if exists tabulacoes_leitura_autenticado on public.tabulacoes;
create policy tabulacoes_leitura_autenticado on public.tabulacoes
  for select
  using (
    not somente_gestao
    or coalesce(public.usuario_e_gestao(), false)
    or coalesce(auth.role(),'') = 'service_role'
  );

grant select on public.tabulacoes to anon, authenticated, service_role;

insert into public.tabulacoes (codigo, rotulo, ordem, grupo, somente_gestao, sistema, bloqueia_acionamento, efeito_desfecho) values
  ('CONTATAR',                      'A contatar',                          10,  'CONTATO',      false, true,  false, null),
  ('MENSAGEM_ENVIADA',              'Mensagem enviada',                    20,  'CONTATO',      false, true,  false, null),
  ('AGUARDANDO_BAIXA',              'Aguardando baixa',                    310, 'FINANCEIRO',   false, true,  false, null),
  ('BAIXA_DEVOLVIDA',               'Baixa devolvida',                     330, 'FINANCEIRO',   false, true,  false, null),
  ('CANCELAMENTO_COBRANCA',         'Cancelamento definitivo de cobrança', 420, 'ENCERRAMENTO', true,  true,  true,  'DEVOLVE_PARCELA'),
  ('SUSPENSAO_COBRANCA',            'Suspensão de cobrança',               430, 'ENCERRAMENTO', true,  true,  true,  'SUSPENDE_PARCELA'),
  ('JURIDICO',                      'Jurídico',                            440, 'ENCERRAMENTO', true,  true,  true,  null),
  ('ANTECIPACAO_SEMESTRE',          'Antecipação de semestre',             540, 'ENCERRAMENTO', true,  false, true,  'DEVOLVE_PARCELA'),
  ('ALEGA_FIES_CONFIRMADO',         'FIES confirmado pela unidade',        550, 'ENCERRAMENTO', true,  false, true,  'DEVOLVE_PARCELA'),
  ('ALEGA_CREDIES_CONFIRMADO',      'CREDIES confirmado pela unidade',     560, 'ENCERRAMENTO', true,  false, true,  'DEVOLVE_PARCELA'),
  ('ALEGA_FINANCIAMENTO_CONFIRMADO','Financiamento confirmado pela unidade',570,'ENCERRAMENTO', true,  false, true,  'DEVOLVE_PARCELA')
on conflict (codigo) do nothing;

-- ---------------------------------------------------------------------------
-- 5. ALUNOS -- mínima, só o que o gatilho vigia
-- ---------------------------------------------------------------------------
create table if not exists public.alunos (
  id                 uuid primary key default gen_random_uuid(),
  nome               text,
  status_atual       text,
  status_jornada     text,
  status_acionamento text
);

grant select, insert, update on public.alunos to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. PAPEL DE APLICAÇÃO -- sem o qual este teste não prova nada
--
-- O gatilho libera quem é "sistema", e a regra inclui
-- `session_user in ('postgres','reativa_responsavel_executor')`. O CI roda
-- psql como `postgres`. Então, pela conexão padrão, a trava NUNCA dispara e
-- todos os casos passariam em verde sem testar coisa alguma.
--
-- `set role` não resolve: ele muda `current_user`, não `session_user`. A única
-- forma honesta é RECONECTAR como um papel que não seja superusuário -- é o
-- que 03_casos faz com `\connect`. `teste_app` é membro de `authenticated`
-- para herdar os grants das tabelas, como o PostgREST faz em produção.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'teste_app') then
    create role teste_app login password 'teste';
  end if;
end $$;

grant authenticated to teste_app;
grant usage on schema public, auth to teste_app;
