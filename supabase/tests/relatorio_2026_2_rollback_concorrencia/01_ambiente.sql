-- Ambiente minimo para o teste de rollback concorrente da PR #947.
-- Dados ficticios. Simula papeis e grants padrao do Supabase.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.email', true), '') $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('app.role', true), ''), 'authenticated')::text $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT NULL::jsonb $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
END $$;

GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;

CREATE TABLE alunos (id uuid PRIMARY KEY, unidade text);
CREATE TABLE acordos_titulos (
  id uuid PRIMARY KEY, aluno_id uuid, cpf text, vencimento date,
  saldo_corrigido numeric, valor_em_aberto numeric, valor_original numeric,
  tipo_boleto text, situacao text, status text, acordo_id uuid
);
CREATE TABLE acordo_titulo_vinculo (titulo_id uuid);
CREATE TABLE casos (aluno_id uuid, status_atual text, status_acionamento text, status_jornada text);
CREATE TABLE solicitacoes_confirmacao_pagamento (aluno_id text, status text);
CREATE OR REPLACE FUNCTION public.normalizar_status_acionamento(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT upper(coalesce(t,'')) $$;
CREATE OR REPLACE FUNCTION public.unaccent(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT t $$;

INSERT INTO alunos VALUES ('00000000-0000-0000-0000-00000000000a', 'OSASCO');
INSERT INTO acordos_titulos (id, aluno_id, cpf, vencimento, saldo_corrigido, valor_em_aberto, valor_original, tipo_boleto, situacao, status, acordo_id)
VALUES ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '52998224725', '2026-08-10', 100, 100, 100,
        'Cursos de Graduação Presencial', 'ABERTO', 'em_aberto', NULL);
