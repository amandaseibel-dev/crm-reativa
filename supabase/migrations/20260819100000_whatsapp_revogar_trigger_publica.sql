-- Central WhatsApp — tirar a função de trigger do alcance público
-- =============================================================================
-- ACHADO (Security Advisor, 2026-08-19, antes do primeiro pareamento):
-- `_trg_whatsapp_aguardando()` é SECURITY DEFINER e estava com EXECUTE para
-- PUBLIC, o que a torna visível em `/rest/v1/rpc/` para `anon` e
-- `authenticated`.
--
-- EXPLORABILIDADE REAL: baixa. A função retorna `trigger`, e o Postgres recusa
-- chamá-la fora de um trigger ("trigger functions can only be called as
-- trigger triggers"). Ou seja, não há caminho conhecido de abuso.
--
-- POR QUE CORRIGIR MESMO ASSIM: ela roda como dono da tabela e escreve em
-- `whatsapp_conversas`. Deixar uma função assim ao alcance de anônimo é apostar
-- que essa recusa do Postgres nunca mude e que ninguém acrescente um caminho de
-- chamada depois. O custo de fechar é zero.
--
-- SEM EFEITO COLATERAL: o disparo de trigger NÃO consulta privilégio EXECUTE —
-- quem executa é o dono da tabela. Revogar não desliga o trigger.
-- =============================================================================

REVOKE ALL ON FUNCTION public._trg_whatsapp_aguardando() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._trg_whatsapp_aguardando() IS
  'Trigger de whatsapp_mensagens: deriva "aguardando resposta"/"sem retorno". Uso interno; sem EXECUTE para anon/authenticated de proposito.';
