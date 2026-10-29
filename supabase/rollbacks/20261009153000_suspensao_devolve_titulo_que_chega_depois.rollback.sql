-- ROLLBACK de 20261009153000_suspensao_devolve_titulo_que_chega_depois.sql
--
-- LEIA ANTES. Este rollback desfaz o COMPORTAMENTO, nao o HISTORICO.
--
-- 1. NAO reabra os titulos que o retroativo devolveu. Eles estao
--    DEVOLVIDO/devolvido com `devolucao_origem = 'SUSPENSAO_COBRANCA'`, que e
--    exatamente a marca que `suspensao_cobranca_reativar` le para restaurar o
--    titulo quando a suspensao for levantada. Reabrir a mao aqui faria a
--    cobranca voltar SEM a decisao da gestao que a levantaria -- e, pela TRAVA
--    de terminalidade (`trg_titulo_devolvido_terminal`), um UPDATE direto nem
--    passa: ele e recusado e registrado em auditoria.
--
--    O caminho legitimo para desfazer a devolucao de UM aluno e, e segue sendo,
--    `select public.suspensao_cobranca_reativar('<aluno_id>', '<motivo>', false);`
--
-- 2. Derrubar o gatilho REABRE O FURO da ordem inversa: titulo que entrar em
--    EM_CONFIRMACAO depois da tabulacao de suspensao volta a ficar pendente na
--    Conferencia Prime para sempre -- o caso da Jessica Linck (e07f8053), em
--    24/09 a 26/09/2026.
--
-- 3. Conferir, DEPOIS de derrubar, quanto o furo passou a acumular de novo:
--      select count(*) as titulos, count(distinct t.aluno_id) as alunos
--        from public.acordos_titulos t
--       where upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO'
--         and public.aluno_bloqueio_administrativo(t.aluno_id) = 'SUSPENSAO_COBRANCA';

-- ---------------------------------------------------------------------------
-- A. O gatilho
-- ---------------------------------------------------------------------------
drop trigger if exists trg_titulo_sob_suspensao_devolve on public.acordos_titulos;
drop function if exists public._titulo_sob_suspensao_devolve();

-- ---------------------------------------------------------------------------
-- B. O retroativo
-- ---------------------------------------------------------------------------
-- Nada depende desta funcao: ela nao e chamada por gatilho, por motor nem pelo
-- front -- e uma ferramenta de gestao, executada sob demanda. Derrubar nao
-- reverte nenhuma devolucao ja feita (ver ponto 1 acima).
drop function if exists public.suspensao_cobranca_devolver_em_confirmacao(text, uuid, boolean);

-- ---------------------------------------------------------------------------
-- C. O que este rollback NAO toca, de proposito
-- ---------------------------------------------------------------------------
--   * `titulo_devolver_da_confirmacao` -- escritor unico, de 20261009080652;
--   * `parcela_efeito_sem_pagamento_aplicar` e `trg_tabulacao_efeito_financeiro`
--     -- a devolucao NO MOMENTO da tabulacao, que ja existia antes desta rodada
--     e continua valendo;
--   * `suspensao_cobranca_reativar` -- intacta;
--   * `acordos_titulos` -- nenhuma coluna, CHECK ou dado desta rodada.
