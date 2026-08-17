-- Rollback do catálogo de tabulações (20260817160000_tabulacoes_catalogo.sql).
--
-- Seguro de rodar: a tabela `tabulacoes` é só catálogo. Nenhum dado de aluno,
-- caso, agendamento ou histórico depende dela por FK -- `alunos.status_atual` e
-- `aluno_movimentacoes.status_novo` continuam sendo texto solto, exatamente
-- como antes. Derrubar isto só faz o frontend voltar às listas hardcoded.
--
-- ATENÇÃO: se a gestão já tiver criado tabulações NOVAS pela tela, os alunos
-- tabulados nelas continuam com aquele código gravado, mas ele deixa de ter
-- rótulo cadastrado (a tela cai no fallback "CODIGO_ASSIM" legível). Exporte
-- antes se quiser guardar:
--   select * from public.tabulacoes order by ordem;

drop function if exists public.tabulacao_reativar(text);
drop function if exists public.tabulacao_desativar(text);
drop function if exists public.tabulacao_salvar(text,text,text,text,integer,text,text,boolean,boolean,integer);
drop function if exists public.tabulacao_impacto(text);

drop table if exists public.tabulacoes;
