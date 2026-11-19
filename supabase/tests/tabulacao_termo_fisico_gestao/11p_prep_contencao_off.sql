-- RESTAURAÇÃO ADMINISTRATIVA (postgres): reverte a contenção e devolve o aluno ao estado de origem. Roda sempre.
\set ON_ERROR_STOP on
update public.termo_fisico_contencao set contencao_ativa = false, alterado_em = clock_timestamp(), alterado_por = 'teste_prep' where id;
update public.alunos set status_atual = 'CONTATAR' where id = 'a0000000-0000-0000-0000-000000000042';
