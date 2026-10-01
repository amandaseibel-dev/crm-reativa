-- ROLLBACK de 20260927221825_efetividade_2026_2_por_competencia.sql
--
-- A migration removeu as três funções por BORDERÔ e criou três por
-- COMPETÊNCIA. Nenhuma tabela, linha, gatilho ou grant de terceiro foi tocado;
-- não há dado a restaurar.
--
-- REVERTER É EM DUAS ETAPAS, nesta ordem:
--   1. executar este arquivo (remove as três funções de competência);
--   2. reaplicar supabase/migrations/20260927180436_efetividade_2026_2_por_bordero.sql
--      (recria as três funções por borderô, exatamente como estavam).
-- A etapa 2 não está embutida aqui de propósito: duplicar o corpo das funções
-- faria a catraca do ledger recusar por cópia (M6), e o arquivo original já
-- existe no repositório e é a fonte.
--
-- AVISA: a tela publicada chama `carteira_2026_2_competencias` e
-- `carteira_2026_2_competencia_detalhe`. Fazer só a etapa 1 deixa a aba
-- "Por competência" da Efetividade 2026/2 recebendo 42883 e mostrando erro.
-- Fazer as duas etapas sem reverter o front deixa a mesma aba chamando funções
-- que não existem mais, com o mesmo efeito. A visão "Consolidado" de 2026/2 e
-- todo o resto do sistema seguem intactos nos dois casos, porque nada fora
-- destas seis funções foi tocado.
--
-- E REGISTRA: reverter reintroduz o erro de atribuição que motivou a mudança —
-- as 21 mensalidades de maio, junho e julho que vivem dentro do borderô 706
-- voltam a ser contadas como agosto.

drop function if exists public.carteira_2026_2_competencia_detalhe(date, text, integer, integer);
drop function if exists public.carteira_2026_2_competencias();
drop function if exists public.carteira_2026_2_classificar();
