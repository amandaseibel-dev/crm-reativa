-- DESFAZER 20260831100000_indice_nome_normalizado_destrava_importacao.sql
--
-- ATENCAO: derrubar este indice faz a importacao da Projecao voltar a falhar
-- com statement timeout em qualquer planilha grande -- o gatilho de vinculo
-- volta a varrer 17 mil alunos por linha importada (127 ms cada).
--
-- So faz sentido junto com a remocao do proprio gatilho
-- `trg_pagamento_vincula_aluno`. Se o objetivo e so parar de vincular por nome,
-- desligue o GATILHO e deixe o indice: ele nao atrapalha nada.

drop index if exists public.ix_alunos_nome_normalizado;
