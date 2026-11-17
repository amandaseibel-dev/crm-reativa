-- RESTAURAÇÃO ADMINISTRATIVA (executor postgres). Roda sempre, mesmo após falha do passo do usuário.
\set ON_ERROR_STOP on
update public.usuarios set ativo = true where email = 'cobranca07@aelbra.com.br';
select 'PREP on cobranca07' as passo;
