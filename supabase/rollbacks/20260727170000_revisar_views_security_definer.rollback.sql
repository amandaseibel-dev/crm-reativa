-- Rollback de 20260727170000_revisar_views_security_definer.sql
-- Restaura o comportamento original das 10 views: SECURITY DEFINER.
--
-- O estado original observado é reloptions = NULL (sem security_invoker),
-- ou seja, o default do Postgres, que equivale a SECURITY DEFINER. Este
-- rollback REMOVE a opção security_invoker (RESET), devolvendo exatamente
-- o estado anterior (reloptions NULL) em vez de fixar security_invoker=false.
--
-- Idempotente: RESET (security_invoker) é repetível; se a opção já não
-- existir, o ALTER é um no-op efetivo.

ALTER VIEW public.consulta_financeira_por_aluno RESET (security_invoker);
ALTER VIEW public.projecao_operador            RESET (security_invoker);
ALTER VIEW public.recuperacoes_consolidadas    RESET (security_invoker);
ALTER VIEW public.vw_alerta_amanda_links_7min  RESET (security_invoker);
ALTER VIEW public.vw_diagnostico_saldo_casos   RESET (security_invoker);
ALTER VIEW public.vw_fila_baixa_amanda         RESET (security_invoker);
ALTER VIEW public.vw_fila_links_adm            RESET (security_invoker);
ALTER VIEW public.vw_links_prioridade_operador RESET (security_invoker);
ALTER VIEW public.vw_links_respondidos         RESET (security_invoker);
ALTER VIEW public.vw_operador_resumo_dia       RESET (security_invoker);

-- ---------------------------------------------------------------------------
-- Parte 2: restaurar EXATAMENTE os grants originais removidos pela migration.
--
-- ATENÇÃO / RISCO DE SEGURANÇA: o único grant original a anon era em
-- vw_diagnostico_saldo_casos, com TODOS os privilégios. Restaurá-lo REABRE
-- O ACESSO ANÔNIMO a 3.891 linhas de saldos/casos (o vazamento que a
-- migration fechou). Só execute este rollback ciente disso.
--
-- PUBLIC: nada a restaurar (não havia grant a PUBLIC em nenhuma das 10 views).
-- authenticated/service_role/postgres não foram tocados pela migration.
-- ---------------------------------------------------------------------------

GRANT ALL ON public.vw_diagnostico_saldo_casos TO anon;
