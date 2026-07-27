-- security(rls): endurecer policies PERMISSIVE de escrita amplas (UPDATE sem WITH CHECK)
--
-- Contexto: auditoria de policies PERMISSIVE para authenticated com INSERT/UPDATE/DELETE/ALL.
-- As policies abaixo tinham USING (titularidade do proprio registro) mas SEM WITH CHECK,
-- permitindo que o operador reatribuisse o registro a OUTRO operador/responsavel
-- durante o UPDATE (troca de titularidade). Adiciona WITH CHECK espelhando a titularidade
-- para impedir a troca de operador/vinculo.
--
-- Nao altera: SELECT, policies RESTRICTIVE, gestao-only, roles internas, service_role/postgres.

ALTER POLICY carteira_update ON carteira_operador
  WITH CHECK (app_usuario_ativo() AND (usuario_e_gestao() OR (lower(COALESCE(operador_email, ''::text)) = app_email())));

ALTER POLICY fila_receptivo_update ON fila_receptivo
  WITH CHECK (app_usuario_ativo() AND (usuario_e_gestao() OR (lower(COALESCE(email, ''::text)) = app_email())));

ALTER POLICY ponto_operadores_update ON ponto_operadores
  WITH CHECK (app_usuario_ativo() AND (usuario_e_gestao() OR (lower(COALESCE(email, ''::text)) = app_email())));

ALTER POLICY solicitacoes_financeiro_update ON solicitacoes_financeiro
  WITH CHECK (app_usuario_ativo() AND (usuario_e_gestao() OR (lower(COALESCE(operador_email, ''::text)) = app_email())));

ALTER POLICY retornos_adm_update ON retornos_adm
  WITH CHECK ((perfil_do_usuario_atual() = ANY (ARRAY['gerencia'::text,'administrativo'::text,'supervisor'::text])) OR (lower(operador_destino_email) = lower(auth.email())));
