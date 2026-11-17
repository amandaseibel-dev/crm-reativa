-- PREPARAÇÃO ADMINISTRATIVA (executor postgres, dono do banco descartável). Não é ação do usuário testado.
\set ON_ERROR_STOP on
update public.usuarios set ativo = false where email = 'gestao.c@exemplo.local';
select 'PREP off gestao.c' as passo;
