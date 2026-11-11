-- ROLLBACK da 20261109160000_ulbra_coleta_posicao
-- Remove só o que a migration criou. Sem a coluna, a função de coleta volta a
-- ler do topo a cada ciclo (comportamento anterior, com o limite de backlog).
-- A versão antiga da função de coleta não lê nem grava offset_pendente, então
-- pode ser republicada antes deste rollback sem efeito colateral.

drop function if exists public.ulbra_sync_posicao_gravar(integer);

alter table public.ulbra_sync_estado
  drop column if exists offset_pendente;
