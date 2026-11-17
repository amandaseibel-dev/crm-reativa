-- RESTAURAÇÃO ADMINISTRATIVA (postgres): devolve a linha de configuração com contenção desligada (estado de origem).
\set ON_ERROR_STOP on
insert into public.termo_fisico_contencao (id, contencao_ativa, alterado_por) values (true, false, 'restauracao_teste') on conflict (id) do update set contencao_ativa = false;
