-- ROLLBACK de 20261114120000_agenda_reagendar_retorno_e_portao_recalculo
-- Remove a RPC, recria o gatilho de zeragem por data e devolve a execucao de
-- recalcular a anon (estado de 20260808150000 e da fixture 20261113).
-- O BACKUP retorno_backup_20261114 NAO e apagado: e a evidencia. Restaurar dados
-- e etapa separada, com aprovacao: ver 20261114120000_restauracao_por_id.sql.pendente.
begin;

drop function if exists public.agenda_reagendar_retorno(uuid, date, text, boolean);

drop trigger if exists trg_aluno_reset_retorno_confirmado on public.alunos;
create trigger trg_aluno_reset_retorno_confirmado
  before update of data_retorno on public.alunos
  for each row
  when (new.data_retorno is distinct from old.data_retorno)
  execute function public.tg_aluno_reset_retorno_confirmado();

-- Nota: na ACL de origem (fixture 20261113) anon NAO tinha EXECUTE em
-- recalcular_situacao_aluno. O revoke da parte D e no-op e o rollback nao concede nada.

commit;
