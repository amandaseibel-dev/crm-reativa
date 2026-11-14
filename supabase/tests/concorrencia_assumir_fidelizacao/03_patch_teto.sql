-- Aplica a serializacao do teto (patch pendente) sobre o ambiente de concorrencia.
-- A ordem exige que a #936 esteja conferida em producao antes de aplicar; aqui o patch roda sobre
-- os corpos de producao das fixtures, que sao os ancorados.
\set ON_ERROR_STOP on
\i supabase/aguardando_aprovacao/20261114110000_serializar_teto_todos_os_caminhos.sql.pendente
