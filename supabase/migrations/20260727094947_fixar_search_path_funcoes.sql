-- Migration: fixar search_path das 2 funções apontadas pelo Advisor (function_search_path_mutable)
-- Funções: public.titulo_esta_em_aberto(uuid,text,text,numeric) e public.fila_acordos_guard_acordo_id()
--
-- Correção mínima e idempotente: define search_path fixo e seguro (vazio).
-- Os corpos usam apenas built-ins do pg_catalog (coalesce, current_user, current_setting),
-- que continuam resolvendo sob search_path vazio — nenhuma qualificação adicional é necessária.
--
-- NÃO altera: lógica, retorno, owner, grants, policies, RLS, triggers ou frontend.
-- Apenas adiciona a cláusula SET search_path a cada função.

ALTER FUNCTION public.titulo_esta_em_aberto(uuid, text, text, numeric)
  SET search_path = '';

ALTER FUNCTION public.fila_acordos_guard_acordo_id()
  SET search_path = '';
