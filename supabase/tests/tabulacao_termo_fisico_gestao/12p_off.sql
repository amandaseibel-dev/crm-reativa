-- RESTAURAÇÃO ADMINISTRATIVA (postgres): reverte a contenção. Roda sempre.
\set ON_ERROR_STOP on
update public.termo_fisico_contencao set contencao_ativa = false, alterado_em = clock_timestamp(), alterado_por = 'teste_prep' where id;
