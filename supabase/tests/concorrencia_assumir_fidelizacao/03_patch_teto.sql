-- Aplica a serializacao do teto (patch pendente) sobre o ambiente de concorrencia.
-- A ordem exige que a #936 esteja conferida em producao antes de aplicar. ATENCAO: o trigger de teto
-- usado aqui e a fixture fidelizacao_por_dono_prod_20260930 (md5 5027a7fa), que NAO e o corpo de producao
-- declarado no patch (3d01bbd1). A ancora existe nas duas versoes; a prova contra 3d01bbd1 esta pendente.
\set ON_ERROR_STOP on
\i supabase/aguardando_aprovacao/20261114110000_serializar_teto_todos_os_caminhos.sql.pendente
