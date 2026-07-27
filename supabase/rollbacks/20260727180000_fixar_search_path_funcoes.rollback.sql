-- Rollback: remove o search_path fixo das 2 funções, restaurando o estado anterior
-- (proconfig = NULL, ou seja, search_path mutável / herdado da sessão).
-- RESET restaura exatamente o comportamento original observado antes da migration.

ALTER FUNCTION public.titulo_esta_em_aberto(uuid, text, text, numeric)
  RESET search_path;

ALTER FUNCTION public.fila_acordos_guard_acordo_id()
  RESET search_path;
