-- ============================================================================
-- ROLLBACK: a triagem das pendencias de pagamento deixa de existir.
--
-- EFEITO: a tela "Pagamentos sem aluno" volta a listar as 448 pendencias sem
-- categoria, sem contador e sem filtro -- o Administrativo volta a descobrir
-- caso a caso, abrindo linha por linha, qual pendencia ele pode resolver hoje e
-- qual esta parada esperando uma etapa desligada. Em particular, as 33
-- pendencias com decisao registrada e status ainda pendente (R$ 83.203,30)
-- voltam a ficar invisiveis: o predicado `and not exists (... decisao is not
-- null)` de `pagamentos_sem_aluno` as esconde da tela, e o mesmo predicado em
-- `fluxo_pagamentos_incremental` as mantem fora da rodada. Nada se perde no
-- banco; o que se perde e a visibilidade.
--
-- ZERO DML na ida e na volta. Nenhum pagamento, acordo, parcela, baixa, status,
-- etapa de `fluxo_pagamentos_config`, job, contador de tentativas ou registro de
-- auditoria e tocado em nenhuma das duas direcoes. Os 8.955 pagamentos
-- historicos (status_conciliacao nulo) nunca estiveram ao alcance da ida e
-- seguem intactos.
--
-- SEGURO DE RODAR A QUALQUER MOMENTO. Os dois objetos sao novos nesta frente:
-- nada no banco depende deles. O unico consumidor e a tela
-- `src/pages/PagamentosSemAluno.jsx`, que trata a ausencia da funcao como
-- "triagem indisponivel" e segue listando a fila como antes -- a lista principal
-- vem de `pagamentos_sem_aluno`, que esta migration nao alterou.
--
-- ORDEM: a funcao primeiro, a view depois -- a funcao depende da view.
-- ============================================================================

drop function if exists public.fila_pagamento_triagem_ler(text, integer);

drop view if exists public.vw_fila_pagamento_triagem;
