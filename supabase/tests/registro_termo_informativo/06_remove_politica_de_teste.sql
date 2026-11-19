-- LIMPEZA (postgres): remove a policy de UPDATE de teste.
\set ON_ERROR_STOP on
drop policy teste_update_permissivo on aluno_movimentacoes;
