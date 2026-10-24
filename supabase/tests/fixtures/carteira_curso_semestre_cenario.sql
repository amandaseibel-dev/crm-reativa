-- Bancada da Minha Carteira: curso e semestre.
--
-- Minima e PROPRIA desta frente. A bancada da rodada incremental
-- (fluxo_incremental_prod_20261021.sql) nao serve aqui: ela tem alunos,
-- acordos e parcelas, mas NAO tem prime_contratos, prime_titulo_semestre,
-- acordos_titulos, acordo_titulo_vinculo, `responsavel_atual_email` nem
-- `parcela_viva` -- cinco das sete coisas que a funcao le.
--
-- Os numeros abaixo sao ESCOLHIDOS, nao medidos: cada ficha existe para
-- provar um caso, e os totais do teste sao conferiveis a mao.

-- Os papeis que os grants da migration citam. No Supabase eles ja existem;
-- aqui precisam ser criados, senao o `grant ... to authenticated` aborta e a
-- migration nem chega a ser avaliada.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
end $$;

create schema if not exists auth;

-- `auth.jwt()` le o claim que o teste planta, como no Supabase.
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', '');
$$;

create table public.usuarios (email text primary key, perfil text);

create or replace function public.usuario_e_gestao() returns boolean
language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email','')) in ('gestao@aelbra.com.br');
$$;

-- Mesmo desenho do de producao: gestao direta OU perfil de gerencia.
create or replace function public.usuario_e_gestao_fila() returns boolean
language sql stable as $$
  select public.usuario_e_gestao()
     or exists (select 1 from public.usuarios u
                 where lower(u.email) = lower(coalesce(auth.jwt()->>'email',''))
                   and u.perfil in ('gerencia','supervisor','administrativo'));
$$;

create or replace function public.parcela_viva(p_status text) returns boolean
language sql immutable as $$
  select upper(coalesce(p_status,'')) not in
    ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO','DEVOLVIDA','SUSPENSA');
$$;

create table public.alunos (
  id uuid primary key,
  cpf text,
  responsavel_atual_email text
);

create table public.prime_contratos (
  cpf text, valid_from date, curso text
);

create table public.prime_titulo_semestre (
  boleto text, semestre text
);

create table public.acordos (
  id uuid primary key, aluno_id uuid, status text
);

create table public.acordos_titulos (
  id uuid primary key,
  aluno_id uuid,
  documento text,
  situacao text,
  status text,
  tipo_boleto text,
  valor_cobranca_ajustado numeric,
  saldo_corrigido numeric,
  valor_em_aberto numeric,
  valor_original numeric,
  acordo_id uuid
);

create table public.acordo_titulo_vinculo (
  titulo_id uuid, acordo_id uuid, ativo boolean default true
);

create table public.parcelas (
  id uuid primary key, acordo_id uuid, valor numeric, status text
);

-- ---------------------------------------------------------------------------
-- OPERADORES
-- ---------------------------------------------------------------------------
insert into public.usuarios values
  ('gerente@aelbra.com.br', 'gerencia'),      -- ve a carteira de qualquer um
  ('op1@aelbra.com.br',     'operador'),
  ('op2@aelbra.com.br',     'operador');

-- ---------------------------------------------------------------------------
-- FICHAS. A1..A6 sao do OP1; B1 e do OP2 (o isolamento se prova com ele).
-- ---------------------------------------------------------------------------
insert into public.alunos (id, cpf, responsavel_atual_email) values
  ('a1111111-0000-0000-0000-000000000001', '11111111111', 'op1@aelbra.com.br'),
  ('a2222222-0000-0000-0000-000000000002', '22222222222', 'op1@aelbra.com.br'),
  ('a3333333-0000-0000-0000-000000000003', '33333333333', 'op1@aelbra.com.br'),
  ('a4444444-0000-0000-0000-000000000004', '44444444444', 'op1@aelbra.com.br'),
  ('a5555555-0000-0000-0000-000000000005', '55555555555', 'op1@aelbra.com.br'),
  ('a6666666-0000-0000-0000-000000000006', '66666666666', 'op1@aelbra.com.br'),
  ('b1111111-0000-0000-0000-00000000000b', '99999999999', 'op2@aelbra.com.br'),
  -- SEM responsavel: nao e carteira de ninguem e nao pode aparecer para ninguem.
  ('c1111111-0000-0000-0000-00000000000c', '88888888888', null);

-- ---------------------------------------------------------------------------
-- CURSOS, por janela de semestre.
--   A1 Medicina nas duas janelas
--   A2 Odontologia so na janela de 2026/2
--   A3 TROCOU: Medicina em 2026/1, Odontologia em 2026/2
--   A4 BIOMEDICINA -- a armadilha: contem "MEDICINA" e NAO e Medicina
--   A5 Medicina nas duas
--   A6 Medicina nas duas
--   B1 Medicina (do OP2)
-- ---------------------------------------------------------------------------
insert into public.prime_contratos (cpf, valid_from, curso) values
  ('11111111111', '2026-03-01', 'MEDICINA'),
  ('11111111111', '2026-08-01', 'MEDICINA'),
  ('22222222222', '2026-08-01', 'ODONTOLOGIA INT/NOT'),
  ('33333333333', '2026-03-01', 'MEDICINA'),
  ('33333333333', '2026-08-01', 'ODONTOLOGIA.'),
  ('44444444444', '2026-03-01', 'BIOMEDICINA'),
  ('44444444444', '2026-08-01', 'BIOMEDICINA'),
  ('55555555555', '2026-03-01', 'MEDICINA VETERINÁRIA  INT/NOT'),
  ('55555555555', '2026-08-01', 'MEDICINA VETERINÁRIA'),
  ('66666666666', '2026-03-01', 'MEDICINA'),
  ('66666666666', '2026-08-01', 'MEDICINA'),
  ('99999999999', '2026-03-01', 'MEDICINA'),
  -- Fora das duas janelas: NAO pode virar curso de 2026/1 nem de 2026/2.
  ('11111111111', '2025-03-01', 'ODONTOLOGIA');

-- ---------------------------------------------------------------------------
-- SERIE DO PRIME (semestre de cada boleto)
-- ---------------------------------------------------------------------------
insert into public.prime_titulo_semestre (boleto, semestre) values
  ('1000001', '2026/1'), ('1000002', '2026/2'),
  ('1000003', '2026/1'), ('1000004', '2026/2'),
  ('1000005', '2026/1'),
  ('1000006', '2025/2'),
  ('1000008', '2026/1'),
  ('1000010', '2026/1'), ('1000011', '2025/1');
  -- '1000007' de proposito AUSENTE: titulo sem serie no Prime.

-- ---------------------------------------------------------------------------
-- MENSALIDADES
--   A1: 2026/1 = 1.000
--   A2: 2026/2 = 500
--   A3: 2026/1 = 300 e 2026/2 = 200   (ficha nos DOIS semestres)
--   A6: 2025/2 = 3.100  +  sem serie = 250
--   B1: 2026/1 = 9.999  (do OP2)
--   C1: 2026/1 = 777    (sem responsavel -- ninguem ve)
-- ---------------------------------------------------------------------------
insert into public.acordos_titulos
  (id, aluno_id, documento, situacao, status, tipo_boleto,
   valor_cobranca_ajustado, saldo_corrigido, valor_em_aberto, valor_original, acordo_id) values
  ('11111111-1111-0000-0000-000000000001','a1111111-0000-0000-0000-000000000001','1000001','ABERTO','em_aberto','Cursos de Graduação Presencial', null, 1000, null, 1200, null),
  ('11111111-1111-0000-0000-000000000002','a2222222-0000-0000-0000-000000000002','1000002','ABERTO','em_aberto','Cursos de Graduação Presencial', null, 500, null, 500, null),
  ('11111111-1111-0000-0000-000000000003','a3333333-0000-0000-0000-000000000003','1000003','ABERTO','em_aberto','Cursos de Graduação Presencial', null, 300, null, 300, null),
  ('11111111-1111-0000-0000-000000000004','a3333333-0000-0000-0000-000000000003','1000004','ABERTO','em_aberto','Cursos de Graduação Presencial', null, 200, null, 200, null),
  ('11111111-1111-0000-0000-000000000006','a6666666-0000-0000-0000-000000000006','1000006','ABERTO','em_aberto','Cursos de Graduação Presencial', null, 3100, null, 3100, null),
  ('11111111-1111-0000-0000-000000000007','a6666666-0000-0000-0000-000000000006','1000007','ABERTO','em_aberto','Cursos de Graduação Presencial', null, 250, null, 250, null),
  ('11111111-1111-0000-0000-00000000000b','b1111111-0000-0000-0000-00000000000b','1000010','ABERTO','em_aberto','Cursos de Graduação Presencial', null, 9999, null, 9999, null),
  ('11111111-1111-0000-0000-00000000000c','c1111111-0000-0000-0000-00000000000c','1000001','ABERTO','em_aberto','Cursos de Graduação Presencial', null, 777, null, 777, null);

-- ---------------------------------------------------------------------------
-- ACORDOS
--   A4: acordo de 2026/1 (titulo 1000005) -> parcelas vivas 2.500
--   A5: acordo SEM titulo vinculado        -> INDETERMINADO 7.000
--   A6: acordo de 2025/1 (titulo 1000011)  -> outros semestres 1.800
--   A1: acordo CANCELADO                   -> nao conta
-- ---------------------------------------------------------------------------
insert into public.acordos (id, aluno_id, status) values
  ('aa000000-0000-0000-0000-00000000000a','a4444444-0000-0000-0000-000000000004','ATIVO'),
  ('aa000000-0000-0000-0000-00000000000b','a5555555-0000-0000-0000-000000000005','ATIVO'),
  ('aa000000-0000-0000-0000-00000000000c','a6666666-0000-0000-0000-000000000006','ATIVO'),
  ('aa000000-0000-0000-0000-00000000000d','a1111111-0000-0000-0000-000000000001','CANCELADO');

-- Titulos que dao semestre ao acordo. `tipo_boleto` de graduacao e
-- `situacao` != DUPLICADA, como a funcao exige.
insert into public.acordos_titulos
  (id, aluno_id, documento, situacao, status, tipo_boleto,
   valor_cobranca_ajustado, saldo_corrigido, valor_em_aberto, valor_original, acordo_id) values
  ('11111111-1111-0000-0000-000000000005','a4444444-0000-0000-0000-000000000004','1000005','NEGOCIADO','vinculada','Cursos de Graduação Presencial', null, 2500, null, 2500, 'aa000000-0000-0000-0000-00000000000a'),
  ('11111111-1111-0000-0000-000000000011','a6666666-0000-0000-0000-000000000006','1000011','NEGOCIADO','vinculada','Cursos de Graduação Presencial', null, 1800, null, 1800, 'aa000000-0000-0000-0000-00000000000c'),
  -- A1: titulo de 2026/1 preso num acordo CANCELADO. A regra de mensalidade
  -- so exclui titulo ligado a acordo NAO cancelado, entao este CONTA como
  -- mensalidade -- e o acordo cancelado nao gera parcela.
  ('11111111-1111-0000-0000-000000000008','a1111111-0000-0000-0000-000000000001','1000008','ABERTO','em_aberto','Cursos de Graduação Presencial', null, 400, null, 400, null);

insert into public.acordo_titulo_vinculo (titulo_id, acordo_id, ativo) values
  -- A4 e A6: o titulo VIROU acordo vivo, entao sai da mensalidade e a divida
  -- passa a ser a parcela. Sem este vinculo o mesmo dinheiro apareceria nas
  -- duas pernas, que e exatamente o que a regra evita.
  ('11111111-1111-0000-0000-000000000005','aa000000-0000-0000-0000-00000000000a', true),
  ('11111111-1111-0000-0000-000000000011','aa000000-0000-0000-0000-00000000000c', true),
  -- A1: vinculo para acordo CANCELADO. A regra so exclui da mensalidade o
  -- titulo ligado a acordo NAO cancelado -- entao este CONTINUA mensalidade.
  ('11111111-1111-0000-0000-000000000008','aa000000-0000-0000-0000-00000000000d', true);

insert into public.parcelas (id, acordo_id, valor, status) values
  ('ff000000-0000-0000-0000-000000000001','aa000000-0000-0000-0000-00000000000a', 2500, 'A_VENCER'),
  ('ff000000-0000-0000-0000-000000000002','aa000000-0000-0000-0000-00000000000b', 7000, 'VENCIDA'),
  ('ff000000-0000-0000-0000-000000000003','aa000000-0000-0000-0000-00000000000c', 1800, 'A_VENCER'),
  -- parcela PAGA nao e viva: nao entra em conta nenhuma.
  ('ff000000-0000-0000-0000-000000000004','aa000000-0000-0000-0000-00000000000a', 900, 'PAGO'),
  -- parcela de acordo CANCELADO: tambem fora.
  ('ff000000-0000-0000-0000-000000000005','aa000000-0000-0000-0000-00000000000d', 50, 'A_VENCER');
