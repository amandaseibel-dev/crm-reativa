-- Rollback: volta a versao sem p_email (gestao ve tudo, sem filtro por operador).
drop function if exists public.acordos_duplicados_sinalizados(text);
-- Reaplicar 20260827132008_listar_acordos_duplicados_sinalizados.sql.
