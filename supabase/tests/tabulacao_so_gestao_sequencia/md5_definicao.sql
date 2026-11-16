-- Imprime o MD5 da definição FINAL de _encerramento_so_gestao() pelo catálogo (não pelo texto do arquivo).
\set ON_ERROR_STOP on
select md5(pg_get_functiondef('public._encerramento_so_gestao()'::regprocedure)) as md5_definicao_final;
