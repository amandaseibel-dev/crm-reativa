-- =============================================================
-- SOLUÇÃO SOMENTE LEITURA — readonly_auditoria
-- Projeto: ahattpqrjmhkzsmnbdzs (produção)
-- Preparado para revisão; NÃO EXECUTAR sem autorização explícita
-- =============================================================
--
-- PROTEÇÕES EM CAMADAS:
--   1. REVOKE EXECUTE FROM PUBLIC nas 12 RPCs write SECURITY DEFINER
--      com PUBLIC execute explícito (verificadas em pg_proc + pg_default_acl)
--      → após REVOKE, readonly_auditoria não herda EXECUTE em nenhuma write function
--   2. Sem INSERT/UPDATE/DELETE (sem grants de escrita)
--   3. RLS SELECT explícito por tabela (sem BYPASSRLS)
--   4. default_transaction_read_only = on (defesa em profundidade)
--   5. Servidor MCP com AST + BEGIN READ ONLY (primeira linha)
--
-- IMPACTO DO REVOKE NAS ROLES EXISTENTES:
--   anon: perde EXECUTE nas 12 funções write — comportamento correto
--         (anon nunca deveria chamar funções write financeiras)
--   authenticated, service_role, postgres: re-grantados — sem impacto no app
--   reativa_responsavel_executor: usa funções no schema internal, não estas 12
--
-- AÇÃO ÚNICA DO ADMINISTRADOR APÓS EXECUÇÃO:
--   Definir senha em: Supabase Dashboard > Database > Roles > readonly_auditoria
--   Depois colocar a string de conexão em .mcp.json (arquivo local, não commitado)
-- =============================================================

BEGIN;

-- 1. Fechar a única lacuna de isolamento:
--    12 RPCs VOLATILE SECURITY DEFINER com PUBLIC EXECUTE explícito que
--    são chamáveis por SQL (retorno != trigger).
--    REVOKE retira de PUBLIC (inclui anon e qualquer role futura como readonly_auditoria).
--    GRANT restaura exatamente para quem já tinha: authenticated, service_role, postgres.
REVOKE EXECUTE ON FUNCTION
  public.caso_encerramento_resolver(uuid, text, text),
  public.caso_encerramento_resolver_aluno(uuid, text, text),
  public.elegibilidade_shadow_rodar(text),
  public.fila_receptivo_marcar_atendido(text, uuid, text),
  public.mensalidade_reconciliar_pago_sem_lastro(boolean),
  public.prime_conferencia_classificar_humano(uuid, text, text),
  public.prime_conferencia_encerrar_administrativo(uuid, text),
  public.prime_conferencia_seguir_pagamento(uuid, uuid, text),
  public.prime_conferencia_triagem_recalcular(uuid[]),
  public.prime_liquidacao_classificar_novas(integer, boolean),
  public.prime_portador_202_coletar(boolean),
  public.titulo_reabrir_quitacao_por_acordo(uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  public.caso_encerramento_resolver(uuid, text, text),
  public.caso_encerramento_resolver_aluno(uuid, text, text),
  public.elegibilidade_shadow_rodar(text),
  public.fila_receptivo_marcar_atendido(text, uuid, text),
  public.mensalidade_reconciliar_pago_sem_lastro(boolean),
  public.prime_conferencia_classificar_humano(uuid, text, text),
  public.prime_conferencia_encerrar_administrativo(uuid, text),
  public.prime_conferencia_seguir_pagamento(uuid, uuid, text),
  public.prime_conferencia_triagem_recalcular(uuid[]),
  public.prime_liquidacao_classificar_novas(integer, boolean),
  public.prime_portador_202_coletar(boolean),
  public.titulo_reabrir_quitacao_por_acordo(uuid)
TO authenticated, service_role, postgres;

-- 2. Role com mínimo privilégio — sem BYPASSRLS, sem herança de grupos
CREATE ROLE readonly_auditoria
  NOINHERIT          -- não herda de role-memberships
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION;
  -- LOGIN e PASSWORD são definidos pelo administrador no Dashboard,
  -- nunca por este script (credencial não passa pelo chat nem pelo repositório)

-- 4. Acesso ao schema
GRANT USAGE ON SCHEMA public TO readonly_auditoria;

-- 3. SELECT nas tabelas de auditoria financeira (sem acesso a outras tabelas)
GRANT SELECT ON
  public.acordos,
  public.alunos,
  public.borderos,
  public.casos,
  public.importacoes,
  public.importacoes_acordos,
  public.operadores,
  public.pagamentos,
  public.parcelas,
  public.usuarios
TO readonly_auditoria;

-- 6. Políticas RLS SELECT (necessárias porque as tabelas têm RLS ativo
--    e readonly_auditoria não tem BYPASSRLS)
--    Escopo: estritamente TO readonly_auditoria — sem efeito em authenticated/anon
--    USING (true) = vê todas as linhas da tabela, apenas leitura
CREATE POLICY ra_acordos         ON public.acordos         FOR SELECT TO readonly_auditoria USING (true);
CREATE POLICY ra_alunos          ON public.alunos          FOR SELECT TO readonly_auditoria USING (true);
CREATE POLICY ra_borderos        ON public.borderos        FOR SELECT TO readonly_auditoria USING (true);
CREATE POLICY ra_casos           ON public.casos           FOR SELECT TO readonly_auditoria USING (true);
CREATE POLICY ra_importacoes     ON public.importacoes     FOR SELECT TO readonly_auditoria USING (true);
CREATE POLICY ra_importacoes_ac  ON public.importacoes_acordos FOR SELECT TO readonly_auditoria USING (true);
CREATE POLICY ra_operadores      ON public.operadores      FOR SELECT TO readonly_auditoria USING (true);
CREATE POLICY ra_pagamentos      ON public.pagamentos      FOR SELECT TO readonly_auditoria USING (true);
CREATE POLICY ra_parcelas        ON public.parcelas        FOR SELECT TO readonly_auditoria USING (true);
CREATE POLICY ra_usuarios        ON public.usuarios        FOR SELECT TO readonly_auditoria USING (true);

-- 7. Transação read-only por padrão (defesa em profundidade)
--    Mesmo que o servidor MCP falhe em bloquear um SET, a sessão inicia
--    em modo somente leitura
ALTER ROLE readonly_auditoria SET default_transaction_read_only = on;

COMMIT;

-- =============================================================
-- VERIFICAÇÃO PÓS-EXECUÇÃO (rodar após aplicar o bloco acima)
-- =============================================================

-- Teste 1: confirma que readonly_auditoria NÃO pode executar
--           nenhuma função VOLATILE SECURITY DEFINER
-- Resultado esperado: 0 linhas
SELECT p.proname
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.provolatile = 'v'
  AND p.prosecdef = true
  AND has_function_privilege('readonly_auditoria', p.oid, 'EXECUTE');

-- Teste 2: confirma que readonly_auditoria NÃO tem INSERT/UPDATE/DELETE
--           em nenhuma tabela
-- Resultado esperado: 0 linhas
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'readonly_auditoria'
  AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');

-- Teste 3: confirma acesso SELECT às tabelas alvo
-- Resultado esperado: uma linha por tabela, privilege_type = 'SELECT'
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'readonly_auditoria'
  AND privilege_type = 'SELECT'
ORDER BY table_name;
