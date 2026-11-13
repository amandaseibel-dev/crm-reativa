-- Rollback de 20261113120000_aluno_termo_fisico_registro.sql.
-- ATENÇÃO: apaga o histórico de registros de termo físico. Só usar se o
-- registro nunca foi usado ou se a gestão decidir descartá-lo. Antes, exportar
-- a tabela se houver dados que precisem ser preservados.
drop function if exists public.termo_fisico_registrar(text, text, boolean);
drop function if exists public.termo_fisico_ler(text);
drop table if exists public.aluno_termo_fisico_eventos;
-- As notificações já enviadas (tipo TERMO_FISICO) não são removidas aqui.
