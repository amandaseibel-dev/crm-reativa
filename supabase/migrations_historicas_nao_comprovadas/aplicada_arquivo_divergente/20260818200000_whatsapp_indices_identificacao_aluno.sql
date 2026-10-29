-- Central WhatsApp — índices para a identificação de aluno por telefone
-- =============================================================================
-- PROBLEMA ENCONTRADO EM PRODUÇÃO (2026-08-18, etapa 6 da implantação):
-- `whatsapp_identificar_aluno` levava **12.730 ms** por chamada e estourava o
-- statement timeout. Toda mensagem que criasse conversa nova era recusada com
-- `canceling statement due to statement timeout` e ficava presa na fila.
--
-- POR QUE STAGING NÃO MOSTROU: lá a base de `alunos` é pequena. Em produção são
-- 17.463 alunos, e a busca fazia varredura sequencial avaliando
-- `whatsapp_chave_telefone` em TRÊS colunas por linha — cerca de 52 mil
-- execuções de regex por mensagem nova.
--
-- CORREÇÃO: índices de expressão sobre a mesma função usada na busca. Ela é
-- IMMUTABLE e não tem cláusula SET, por isso pode ser indexada. O planejador
-- passa a combinar os três índices por BitmapOr no lugar do seq scan.
--
-- RESULTADO MEDIDO: 12.730 ms -> **7,6 ms**.
--
-- ATENÇÃO AO APLICAR: `CREATE INDEX CONCURRENTLY` **não roda dentro de
-- transação**. Se a ferramenta de migration envolver tudo num BEGIN, rode estes
-- três comandos manualmente, um a um. O CONCURRENTLY é proposital: `alunos` é a
-- tabela mais quente do CRM e a construção do índice leva alguns segundos por
-- causa do custo da função — travar escrita nela em horário de operação sairia
-- caro. Em produção foram aplicados assim, um por vez, sem lock de escrita.
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_alunos_wa_chave_telefone
  ON public.alunos (public.whatsapp_chave_telefone(telefone));

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_alunos_wa_chave_resp1
  ON public.alunos (public.whatsapp_chave_telefone(telefone_resp1));

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_alunos_wa_chave_resp2
  ON public.alunos (public.whatsapp_chave_telefone(telefone_resp2));

COMMENT ON INDEX public.ix_alunos_wa_chave_telefone IS
  'Identificacao de aluno por telefone na Central WhatsApp. Sem ele a busca leva ~12s e estoura o statement timeout.';
