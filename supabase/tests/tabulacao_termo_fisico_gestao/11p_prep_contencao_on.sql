-- PREPARAÇÃO ADMINISTRATIVA (postgres): aluno com código restrito já gravado + contenção aplicada.
\set ON_ERROR_STOP on
update public.alunos set status_atual = 'TERMO_FISICO_ARQUIVADO' where id = 'a0000000-0000-0000-0000-000000000042';
update public.termo_fisico_contencao set contencao_ativa = true, alterado_em = clock_timestamp(), alterado_por = 'teste_prep' where id;
