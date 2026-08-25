-- Rollback da conferência Prime.
--
-- Remove apenas as duas funções: nenhuma tabela é criada por esta migration, e
-- os títulos já baixados por ela NÃO são revertidos aqui de propósito -- baixa
-- desfeita em massa é decisão de gente, não de script. Para achar o que foi
-- baixado por esse caminho:
--
--   select * from public.aluno_movimentacoes
--   where tipo = 'BAIXA_CONFERENCIA_PRIME' order by registrado_em desc;

drop function if exists public.prime_conferencia_baixar(uuid, text);
drop function if exists public.prime_conferencia_listar();
