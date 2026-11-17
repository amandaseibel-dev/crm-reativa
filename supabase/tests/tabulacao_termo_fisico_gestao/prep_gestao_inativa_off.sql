-- PREPARAÇÃO ADMINISTRATIVA (executor postgres, dono do banco descartável). Não é ação do usuário testado.
\set ON_ERROR_STOP on
update public.usuarios set ativo = false where email = 'cobranca07@aelbra.com.br';
select 'PREP off cobranca07' as passo;
