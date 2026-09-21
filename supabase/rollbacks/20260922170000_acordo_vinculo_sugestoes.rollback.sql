-- ROLLBACK de 20260922170000: remove a fila assistida (funcoes e tabela de decisoes). Nenhum vinculo criado por ela e desfeito.
begin;
drop function if exists public.acordo_vinculo_sugestao_rejeitar(uuid, text, text);
drop function if exists public.acordo_vinculo_sugestao_confirmar(uuid, text);
drop function if exists public.acordos_vinculo_sugestoes();
drop function if exists public.acordo_vinculo_sugestoes_calcular(uuid);
drop table if exists public.acordo_vinculo_sugestao_decisao;
commit;
