-- ROLLBACK de 20261023210000_importacao_conferencia_por_arquivo
-- =============================================================================
-- Remove a conferência por arquivo: duas funções de leitura e uma view de
-- leitura. Nada mais existe para desfazer -- a migration de ida não gravou
-- nenhuma linha, não criou coluna, gatilho, índice nem agendamento, e não
-- alterou motor de conciliação, parcelas, acordos, baixas ou saldos.
--
-- SEGURO POR CONSTRUÇÃO, e não por promessa: o que se apaga aqui é um recorte
-- de LEITURA. Nenhum dado de pagamento, baixa ou pendência vive nestes objetos
-- -- eles só projetam o que já está em `pagamentos`, `parcelas`,
-- `fila_pagamento_sem_vinculo` e `vw_fila_pagamento_triagem`.
--
-- O QUE REVERTER CUSTA: a tela "Por arquivo" da Central de Pagamentos deixa de
-- carregar (as duas RPCs somem). As outras abas da Central, a triagem da #737 em
-- `/pagamentos-sem-aluno` e a importação pela Projeção seguem funcionando --
-- nenhuma delas depende destes objetos.
--
-- NÃO REMOVE, de propósito: `vw_fila_pagamento_triagem` e
-- `fila_pagamento_triagem_ler`, que são da PR #737 e têm vida própria. Esta
-- migration apenas LÊ a triagem; apagá-la aqui derrubaria a tela da #737.
--
-- Idempotente: `if exists` nos três objetos.
begin;

drop function if exists public.importacao_conferencia_ler(uuid, text, text, integer);
drop function if exists public.importacao_conferencia_arquivos(integer);
drop view if exists public.vw_importacao_conferencia;

commit;
