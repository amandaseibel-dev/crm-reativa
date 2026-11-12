-- Depois do ROLLBACK da 20261109160000: a coluna e a função somem, e o resto
-- do estado da coleta (piso_pendente, topo_processado) continua de pé.
\set ON_ERROR_STOP on
select 1 / (case when not exists (select 1 from information_schema.columns
  where table_schema='public' and table_name='ulbra_sync_estado' and column_name='offset_pendente') then 1 else 0 end);
select 1 / (case when not exists (select 1 from information_schema.routines
  where routine_schema='public' and routine_name='ulbra_sync_posicao_gravar') then 1 else 0 end);
select 1 / (case when exists (select 1 from information_schema.columns
  where table_schema='public' and table_name='ulbra_sync_estado' and column_name='piso_pendente') then 1 else 0 end);
