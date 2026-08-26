-- Rollback: tira o "replicar nas outras". Volta a ser uma parcela por vez
-- (parcela_definir_honorario) ou o total rateado (acordo_definir_honorarios).
drop function if exists public.parcela_replicar_honorario(uuid, text);
