-- LIMPEZA DO LOTE SINTETICO DO SMOKE.
--
-- As 3 linhas de `SMOKE_BACKFILL_RPC_20260915` foram criadas para provar a
-- cadeia `Edge -> PostgREST -> RPC SECURITY DEFINER -> stage` em producao.
-- Cumprido o papel, saem.
--
-- Nada de dado pessoal nesta instrucao: so o nome do lote sintetico.
--
-- A GUARDA E O PONTO: o delete e restrito ao lote do smoke, e o bloco aborta se
-- encontrar qualquer coisa alem das 3 linhas esperadas, ou se o lote real
-- tivesse sobrado alguma linha na stage. O lote real ja foi aplicado e sua
-- procedencia vive em `backfill_matricula_origem`, que nao e tocada aqui.

do $limpeza$
declare v_smoke int; v_outros int; v_apagadas int;
begin
  select count(*) into v_smoke from public.backfill_matricula_stage
   where lote = 'SMOKE_BACKFILL_RPC_20260915';
  select count(*) into v_outros from public.backfill_matricula_stage
   where lote <> 'SMOKE_BACKFILL_RPC_20260915';

  if v_smoke <> 3 then
    raise exception 'esperava 3 linhas sinteticas, encontrei % -- nao apago as cegas', v_smoke;
  end if;
  if v_outros <> 0 then
    raise exception 'ha % linhas de OUTRO lote na stage -- parar e conferir antes', v_outros;
  end if;

  -- o lote real tem de estar aplicado e intacto ANTES de eu mexer em qualquer coisa
  if (select count(*) from public.backfill_matricula_lotes
       where lote = 'MATRICULA_SANTANDER_JUL_AGO_2026_A' and status = 'APLICADO'
         and quantidade_aplicada = 7401) <> 1 then
    raise exception 'o lote real nao esta aplicado como esperado';
  end if;
  if (select count(*) from public.backfill_matricula_origem
       where lote = 'MATRICULA_SANTANDER_JUL_AGO_2026_A') <> 7401 then
    raise exception 'a trilha do lote real nao tem 7401 linhas';
  end if;

  delete from public.backfill_matricula_stage
   where lote = 'SMOKE_BACKFILL_RPC_20260915';
  get diagnostics v_apagadas = row_count;

  if v_apagadas <> 3 then
    raise exception 'apaguei % linhas, esperava 3 -- rollback', v_apagadas;
  end if;
  if (select count(*) from public.backfill_matricula_stage) <> 0 then
    raise exception 'a stage nao ficou vazia';
  end if;
end $limpeza$;