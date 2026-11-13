-- Rollback de 20261113120000_aluno_termo_fisico_registro.sql.
-- NÃO APAGA DADOS. A tabela é só renomeada, para o histórico continuar
-- disponível para auditoria. Apagá-la de vez é um passo separado, e só depois
-- de backup conferido pela gestão (premissa de backup antes de drop).
drop function if exists public.termo_fisico_registrar(text, text, boolean);
drop function if exists public.termo_fisico_ler(text);
drop trigger if exists aluno_termo_fisico_eventos_sem_update_delete on public.aluno_termo_fisico_eventos;
drop function if exists public.aluno_termo_fisico_eventos_imutavel();
alter table if exists public.aluno_termo_fisico_eventos
  rename to aluno_termo_fisico_eventos_descartada_20261113;
-- As notificações já enviadas (tipo TERMO_FISICO) não são removidas aqui.
