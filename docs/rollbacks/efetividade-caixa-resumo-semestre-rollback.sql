-- ROLLBACK da migration 20261115130000_efetividade_caixa_resumo_semestre.sql
-- Só executar se a migration tiver sido aplicada. Remove apenas a função nova;
-- não toca em dados, na view `efetividade_caixa_origem` nem nas RPCs existentes.
drop function if exists public.efetividade_caixa_resumo_semestre(text);
