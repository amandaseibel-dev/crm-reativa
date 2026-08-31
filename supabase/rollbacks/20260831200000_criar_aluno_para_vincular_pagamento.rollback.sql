-- DESFAZER 20260831200000_criar_aluno_para_vincular_pagamento.sql
--
-- ATENCAO: desfazer volta a deixar o sistema SEM nenhum caminho de tela para
-- cadastrar aluno. Quem entrar dinheiro sem estar na base volta a so poder ser
-- resolvido montando uma planilha de uma linha em /importar-acordos.
--
-- Os alunos ja cadastrados por aqui NAO sao removidos -- eles tem pagamento
-- vinculado. Para encontra-los: origem = 'CADASTRO_CONFERENCIA'.

drop function if exists public.criar_aluno_para_vinculo(text, text, text);
