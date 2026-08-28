update public.casos c set encerrado_operacional = false
  from public._backup_caso_dup_trio_20260828 b where c.id = b.sai;
