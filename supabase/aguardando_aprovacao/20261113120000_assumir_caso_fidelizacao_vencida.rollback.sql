-- ROLLBACK de 20261113120000_assumir_caso_fidelizacao_vencida.
-- Remove a RPC nova. Nao toca casos, alunos, historico nem a auditoria ja gravada:
-- as linhas ASSUMIR_FIDELIZACAO_VENCIDA ficam como registro historico.
drop function if exists public.assumir_caso_fidelizacao_vencida(uuid, text);
