-- Rollback de 20261109180000_ulbra_vinculo_leitura: remove so a funcao de leitura.
begin;
drop function if exists public.ulbra_vinculo_aluno(uuid);
commit;
