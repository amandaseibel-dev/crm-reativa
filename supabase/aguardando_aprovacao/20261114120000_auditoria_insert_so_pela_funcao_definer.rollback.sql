-- ROLLBACK da 20261114120000 (auditoria). Restaura o estado anterior à migration.
-- Transacional por si só (begin/commit). Não apaga dados: só volta privilégio e modo de execução.
begin;
alter function public._titulo_em_confirmacao_protegido() security invoker reset search_path;
grant insert on public.auditoria to authenticated, anon;
commit;
