-- Aposentadas duas filas que existiam por AUSENCIA de dado.
--
-- Amanda, 29/08/2026: "criar uma fila unica, sem suposicoes e sim com quem
-- realmente pagou".
--
-- `acordos_sem_pagamento` e `quitacoes_a_conferir` nasceram no mesmo dia e sobre
-- a pergunta errada: "quem NAO pagou?" -- que so se responde por ausencia de
-- registro. Com R$ 3,48 mi de baixa manual pendente, ausencia mede o NOSSO
-- atraso, nao o aluno; os rotulos das duas ja tinham precisado de correcao no
-- mesmo dia por tratarem suposicao como fato.
--
-- A pergunta certa e "quem pagou?", e ela tem resposta no extrato do Santander.
-- Medido antes de aposentar:
--   CONCILIAR de acordos_sem_pagamento: 343 itens, 343 ja na conciliacao_santander;
--   1.743 itens por ausencia, so 240 com evidencia de pagamento;
--   472 quitacoes "sem lastro" -- suposicao pura;
--   206 quitacoes com lastro fora da conciliacao: ja com saldo ZERO, resolvidas.
--
-- O numero dos 1.503 sem pagamento localizado segue util como sinal de gestao no
-- relatorio -- so nao como fila com botao de acao.
--
-- `backlog_manual()` FICA (20260828380000): mede quanto falta lancar.

drop function if exists public.acordos_sem_pagamento();
drop function if exists public.quitacoes_a_conferir(date);
