-- ROLLBACK: guard_usuarios_self_update
--
-- Reverte SOMENTE os objetos criados pela migration
-- supabase/migrations/20260727230000_guard_usuarios_self_update.sql:
--   * o trigger BEFORE UPDATE trg_usuarios_guard_self_update em public.usuarios;
--   * a funcao public.fn_guard_usuarios_self_update().
--
-- NAO altera policies, grants, dados nem qualquer outra estrutura.
-- Aplicar manualmente (NAO faz parte do diretorio de migrations) apenas se
-- o guard causar regressao em producao.

BEGIN;

DROP TRIGGER IF EXISTS trg_usuarios_guard_self_update ON public.usuarios;

DROP FUNCTION IF EXISTS public.fn_guard_usuarios_self_update();

COMMIT;
