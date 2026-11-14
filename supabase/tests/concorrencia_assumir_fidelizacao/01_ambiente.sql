-- Ambiente de CONCORRENCIA: mesmas fixtures de producao (md5 por corpo) usadas
-- pelo teste PGlite, num Postgres real (CI, postgres:16 descartavel).
\set ON_ERROR_STOP on
create extension if not exists unaccent;
create extension if not exists pg_trgm;
create extension if not exists "uuid-ossp";
\i supabase/tests/fixtures/fidelizacao_por_dono_prod_20260930.sql
\i supabase/tests/fixtures/assumir_caso_livre_prod_20261020.sql
\i supabase/tests/fixtures/assumir_caso_fidelizacao_vencida_prod_20261113.sql
insert into public.usuarios (nome, email, perfil, ativo, operador_nome, recebe_novos_casos) values
  ('LUANA',    'cobranca05@aelbra.com.br', 'operador', true, 'LUANA', true),
  ('MAURICIO', 'cobranca06@aelbra.com.br', 'operador', true, 'MAURICIO', true),
  ('AMANDA GESTORA', 'amanda.seibel@aelbra.com.br', 'gerencia', true, null, false);
update public.usuarios set pode_alterar_responsavel = true where lower(email) = 'amanda.seibel@aelbra.com.br';
insert into public.calibragem_parametros (chave, valor) values ('limite_carteira', '700'::jsonb)
  on conflict (chave) do update set valor = excluded.valor;
\i supabase/aguardando_aprovacao/20261113120000_assumir_caso_fidelizacao_vencida.sql.pendente
