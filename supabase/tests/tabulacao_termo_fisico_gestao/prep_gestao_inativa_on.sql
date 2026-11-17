-- RESTAURAÇÃO ADMINISTRATIVA (executor postgres). Roda sempre, mesmo após falha do passo do usuário.
\set ON_ERROR_STOP on
update public.usuarios set ativo = true where email = 'gestao.c@exemplo.local';
select 'PREP on gestao.c' as passo;
