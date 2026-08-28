-- devolve as copias para a fila e desfaz a heranca de operador/acionamento
update public.casos c set encerrado_operacional = false
  from public._backup_caso_fantasma_20260828 b where c.id = b.caso_fantasma_id;
update public.casos c
   set operador_email = b.real_operador_antes,
       data_ultimo_acionamento = b.real_acionamento_antes
  from public._backup_caso_fantasma_20260828 b where c.id = b.caso_real_id;
