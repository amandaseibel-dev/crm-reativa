-- Rollback: tira a possibilidade de ajustar o honorário de uma parcela isolada.
-- Sobra só o honorário do acordo inteiro (acordo_definir_honorarios, que
-- rateia) e o campo na hora da baixa. Acordo antigo volta a não ter como ser
-- corrigido parcela a parcela.
drop function if exists public.parcela_definir_honorario(uuid, numeric, text);
