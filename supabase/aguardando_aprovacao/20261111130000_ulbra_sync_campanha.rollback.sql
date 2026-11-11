-- ROLLBACK da 20261111130000: remove as funções e as colunas da campanha. Não toca no resto do estado.
drop function if exists public.ulbra_sync_campanha_reservar(text, integer, integer);
drop function if exists public.ulbra_sync_campanha_devolver(text, integer);
alter table public.ulbra_sync_estado
  drop column if exists campanha_id,
  drop column if exists campanha_teto,
  drop column if exists campanha_reservadas,
  drop column if exists campanha_iniciada_em;
