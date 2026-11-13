-- ROLLBACK de 20261113120000_assumir_caso_fidelizacao_vencida.
--
-- Remove as duas RPCs. NAO apaga a tabela public.assumir_fidelizacao_operacoes
-- (historico de auditoria: nunca apagar linhas). NAO desfaz tomadas ja feitas:
-- para desfazer uma tomada, usar reverter_assumir_fidelizacao(operacao_id) ANTES
-- deste rollback, ou tratar caso a caso com a gestao. Desfazer tomadas em lote
-- exige backup por identificador de operacao, nunca snapshot cego. Esse backup AINDA NAO EXISTE: e pre-condicao antes de qualquer aplicacao.
drop function if exists public.reverter_assumir_fidelizacao(uuid, text);
drop function if exists public.assumir_caso_fidelizacao_vencida(uuid, text);
