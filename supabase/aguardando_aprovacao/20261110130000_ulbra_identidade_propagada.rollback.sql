-- ROLLBACK da 20261110130000_ulbra_identidade_propagada
-- Remove só os gatilhos e as funções. NÃO reverte os statuses já corrigidos:
-- a reconciliação é uma alteração de dados, revertida só por decisão própria.
drop trigger if exists trg_ulbra_vinculos_trava on public.ulbra_vinculos;
drop trigger if exists trg_ulbra_vinculos_propaga on public.ulbra_vinculos;
drop trigger if exists trg_ulbra_atendimentos_identidade on public.ulbra_atendimentos;
drop trigger if exists trg_ulbra_conversas_identidade on public.ulbra_conversas;
drop function if exists public._ulbra_identidade_propagar();
drop function if exists public._ulbra_vinculo_trava();
drop function if exists public._ulbra_identidade_conversa();
drop function if exists public._ulbra_identidade_atendimento();
