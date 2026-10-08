-- ROLLBACK de 20261008120542_confirmacao_pendente_triagem.sql
--
-- A migration e SO DDL e SO LEITURA: uma funcao nova, nenhuma tabela, nenhum
-- gatilho, nenhum dado escrito. Nao ha dado a restaurar.
--
-- O QUE NAO FOI TOCADO: solicitacoes_confirmacao_pagamento, casos, alunos,
-- acordos, parcelas, pagamentos, a protecao de confirmacao financeira
-- (`caso_protegido_redistribuicao`, `nivelamento_automatico_gestao`,
-- `alunos_em_confirmacao_pendente`), o fluxo de decisao da aba
-- (`confirmar_pagamento_solicitacao`, `confirmar_saldo_zero_retirar_filas`,
-- `quitar_e_encerrar_caso`) e a Fila Operacional.
--
-- EFEITO NA TELA depois do rollback: a aba perde o painel de triagem e volta a
-- listar as solicitacoes como antes. O componente trata o erro da RPC e mostra
-- o aviso, sem derrubar a aba.

drop function if exists public.confirmacao_pendente_triagem();
