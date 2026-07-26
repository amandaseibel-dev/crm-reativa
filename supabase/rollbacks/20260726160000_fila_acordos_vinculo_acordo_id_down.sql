-- ROLLBACK de 20260726160000_fila_acordos_vinculo_acordo_id.sql
--
-- Remove o vínculo explícito por acordo_id, as RPCs, a guarda e a auditoria.
-- Idempotente (IF EXISTS). NÃO restaura a antiga inferência por
-- (aluno_id, qtd_parcelas, valor_total) — ela foi intencionalmente descontinuada.
--
-- ATENÇÃO: dropar a coluna acordo_id apaga os vínculos manuais já feitos.
-- Execute somente se for realmente reverter a feature.

-- RPCs
drop function if exists public.fila_buscar_acordo(bigint);
drop function if exists public.fila_acordos_responsavel();
drop function if exists public.fila_vincular_acordo(uuid, uuid, text);

-- Guarda
drop trigger if exists trg_fila_acordos_guard_acordo_id on public.fila_acordos_confirmar;
drop function if exists public.fila_acordos_guard_acordo_id();

-- Allowlist
drop function if exists public.fila_acordos_pode_vincular(text);

-- Coluna / FK / índice
alter table public.fila_acordos_confirmar
  drop constraint if exists fila_acordos_confirmar_acordo_id_fkey;
drop index if exists public.idx_fila_acordos_confirmar_acordo_id;
alter table public.fila_acordos_confirmar
  drop column if exists acordo_id;

-- Auditoria
drop index if exists public.idx_fila_acordos_vinculo_aud_fila;
drop table if exists public.fila_acordos_vinculo_auditoria;
