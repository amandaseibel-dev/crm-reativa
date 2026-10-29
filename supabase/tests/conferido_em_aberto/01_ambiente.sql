-- AMBIENTE ISOLADO para validar PROPOSTA_conferido_em_aberto.sql.
--
-- Roda num Postgres descartavel do CI (servico do GitHub Actions). NAO fala com
-- producao, NAO usa segredo, NAO custa nada -- o repositorio e publico.
--
-- O QUE ESTE ARQUIVO RECRIA, e por que cada parte importa:
--
--   1. OS PAPEIS do Supabase (anon, authenticated, service_role). Sem eles os
--      revoke/grant da proposta nao teriam em quem pegar e a guarda de ACL
--      passaria batido -- que e justamente o que ela existe para impedir.
--
--   2. O ALTER DEFAULT PRIVILEGES. Esta e a parte que mais engana: em producao,
--      objeto criado por postgres em `public` NASCE com privilegio para
--      authenticated. Sem reproduzir isso aqui, o teste nao exercitaria a
--      armadilha -- a funcao nasceria fechada por acidente e a guarda diria
--      "tudo certo" sem ter verificado nada.
--
--   3. OS STUBS de auth.jwt(), auth.role(), usuario_e_gestao() e
--      carteira_2026_1_pode_ler(). Sao o portao de permissao; num banco vazio
--      eles nao existem, e sem eles a RPC nao teria o que checar.
--
--   4. O ESQUEMA MINIMO e os dados semeados -- so as tabelas que o classificador
--      le, com titulos cobrindo cada ramo da classificacao.
--
--   5. O CLASSIFICADOR DE PRODUCAO de 28/09/2026, tal como esta hoje. A proposta
--      e aplicada POR CIMA dele, entao o teste mede a mudanca real, nao uma
--      reescrita conveniente. E o revoke da versao 20260927224458 e aplicado
--      aqui tambem, para o estado inicial ser o estado verdadeiro.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. PAPEIS
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. A ARMADILHA DO DEFAULT -- reproduzida de proposito.
-- ---------------------------------------------------------------------------
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all     on tables    to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. STUBS DE AUTENTICACAO -- lidos de GUC, para o teste trocar de usuario.
-- ---------------------------------------------------------------------------
create schema if not exists auth;

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select jsonb_build_object('email', coalesce(current_setting('teste.email', true), ''));
$$;

create or replace function auth.role() returns text language sql stable as $$
  select coalesce(current_setting('teste.role', true), 'authenticated');
$$;

create or replace function public.usuario_e_gestao() returns boolean language sql stable as $$
  select coalesce(current_setting('teste.gestao', true), 'false') = 'true';
$$;

-- O portao de leitura do painel. Aqui sempre true: quem ele barra e operador
-- sem permissao no painel, que nao e o que esta sob teste neste arquivo.
create or replace function public.carteira_2026_1_pode_ler() returns boolean language sql stable as $$
  select true;
$$;

-- ---------------------------------------------------------------------------
-- 4. ESQUEMA MINIMO
-- ---------------------------------------------------------------------------
create table public.alunos (
  id uuid primary key, nome text, cpf text
);

create table public.acordos (
  id uuid primary key, numero_ulbra text, status text, cpf text
);

create table public.acordos_titulos (
  id uuid primary key, aluno_id uuid, cpf text, documento text, vencimento date,
  valor_original numeric, saldo_corrigido numeric, valor_em_aberto numeric,
  situacao text, tipo_boleto text, importacao_id uuid,
  created_at timestamp default now(), acordo_id uuid, origem_encerramento text,
  valor_cobranca_ajustado numeric, atualizado_em timestamptz default now()
);

create table public.acordo_titulo_vinculo (
  id uuid primary key default gen_random_uuid(), titulo_id uuid, acordo_id uuid, ativo boolean
);

create table public.parcelas (
  id uuid primary key default gen_random_uuid(), acordo_id uuid, valor numeric,
  status text, vencimento date, boleto text
);

create table public.pagamentos (
  id uuid primary key default gen_random_uuid(), aluno_id uuid,
  numero_parcela_completo text, data_pagamento date
);

create table public.prime_titulo_semestre (
  boleto text, semestre text, liquidado_em date, coletado_em timestamptz default now()
);

create table public.prime_contratos (
  cpf text, status text, valid_from date
);

create table public.prime_conferencia_decisao (
  titulo_id uuid primary key, decisao text, motivo text,
  decidido_por text, decidido_em timestamptz
);

create table public.aluno_movimentacoes (
  id bigserial primary key, aluno_id text, tipo text, descricao text,
  status_anterior text, status_novo text, registrado_por_nome text,
  registrado_por_email text, registrado_em timestamptz, valor_movimentacao numeric
);

-- ---------------------------------------------------------------------------
-- 5. DADOS -- um titulo por ramo da classificacao.
--
-- Vencimento 05/08/2026 em todos: liq_real exige liquidacao DEPOIS de
-- vencimento+30 (04/09/2026) e depois da entrada no CRM.
-- ---------------------------------------------------------------------------
insert into public.alunos (id, nome, cpf) values
  ('a0000000-0000-4000-8000-000000000001','ALUNO UM',  '11111111111'),
  ('a0000000-0000-4000-8000-000000000002','ALUNO DOIS','22222222222'),
  ('a0000000-0000-4000-8000-000000000003','ALUNO TRES','33333333333'),
  ('a0000000-0000-4000-8000-000000000004','ALUNO QUATRO','44444444444'),
  ('a0000000-0000-4000-8000-000000000005','ALUNO CINCO','55555555555'),
  ('a0000000-0000-4000-8000-000000000006','ALUNO SEIS','66666666666'),
  ('a0000000-0000-4000-8000-000000000007','ALUNO SETE','77777777777'),
  ('a0000000-0000-4000-8000-000000000008','ALUNO OITO','88888888888');

insert into public.acordos (id, numero_ulbra, status, cpf) values
  ('c0000000-0000-4000-8000-000000000001','90001','ATIVO','44444444444');
insert into public.parcelas (acordo_id, valor, status, vencimento, boleto) values
  ('c0000000-0000-4000-8000-000000000001', 4000, 'A_VENCER', '2026-10-05', '5900010001');

insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido, situacao, tipo_boleto, created_at, acordo_id)
values
  -- T1 EM_CONFERENCIA por liquidacao no Prime sem origem -- o alvo do teste
  ('70000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','11111111111','1000001','2026-08-05',1000,1000,'ABERTO','Mensalidade','2026-07-01',null),
  -- T2 EM_CONFERENCIA por ausencia de confirmacao (serie sem liquidacao)
  ('70000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000002','22222222222','1000002','2026-08-05',2000,2000,'ABERTO','Mensalidade','2026-07-01',null),
  -- T3 EM_CONFERENCIA por caixa fora do CRM
  ('70000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000003','33333333333','1000003','2026-08-05',3000,3000,'ABERTO','Mensalidade','2026-07-01',null),
  -- T4 CONVERTIDO: tem acordo
  ('70000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000004','44444444444','1000004','2026-08-05',4000,4000,'ABERTO','Mensalidade','2026-07-01','c0000000-0000-4000-8000-000000000001'),
  -- T5 PAGO com diferenca ZERO: nao cai em CONVERTIDO, mas e pagamento
  ('70000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-000000000005','55555555555','1000005','2026-08-05',5000,5000,'PAGO','Mensalidade','2026-07-01',null),
  -- T6 EM_CONFERENCIA com decisao REJEITADO na fila (bolsa/debito indevido)
  ('70000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-000000000006','66666666666','1000006','2026-08-05',6000,6000,'ABERTO','Mensalidade','2026-07-01',null),
  -- T7 EM_CONFERENCIA por nao existir linha nenhuma no Prime
  ('70000000-0000-4000-8000-000000000007','a0000000-0000-4000-8000-000000000007','77777777777','1000007','2026-08-05',7000,7000,'ABERTO','Mensalidade','2026-07-01',null),
  -- T8 SEM_NEGOCIACAO desde o inicio -- a testemunha: nunca pode se mexer
  ('70000000-0000-4000-8000-000000000008','a0000000-0000-4000-8000-000000000008','88888888888','1000008','2026-08-05',8000,8000,'ABERTO','Mensalidade','2026-07-01',null);

insert into public.prime_titulo_semestre (boleto, semestre, liquidado_em) values
  ('1000001','2026/2','2026-09-20'),   -- liq_real
  ('1000002','2026/2', null),          -- sem confirmacao
  ('1000003','2026/2','2026-08-10'),   -- liquidado cedo: nao e liq_real
  ('1000004','2026/2', null),
  ('1000005','2026/2','2026-09-20'),   -- liq_real
  ('1000006','2026/2','2026-09-20'),   -- liq_real
  ('1000008','2026/2','2026-08-10');   -- nao e liq_real, e sem caixa fora
-- T7 NAO tem linha: e assim que "sem confirmacao do Prime" acontece de verdade.

-- Caixa fora do CRM so para o aluno de T3.
insert into public.pagamentos (aluno_id, numero_parcela_completo, data_pagamento) values
  ('a0000000-0000-4000-8000-000000000003','8888888888','2026-08-01');

insert into public.prime_conferencia_decisao (titulo_id, decisao, motivo, decidido_por, decidido_em) values
  ('70000000-0000-4000-8000-000000000006','REJEITADO','aluno possui bolsa, o debito e indevido','gestao@teste', now());
