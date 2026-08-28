update public.casos c set encerrado_operacional = false
  from public._backup_caso_dup_cpf_20260828 b where c.id = b.sai;
update public.casos c
   set matricula = b.matricula_antes, operador_email = b.operador_antes,
       data_ultimo_acionamento = b.acionamento_antes
  from public._backup_caso_dup_cpf_20260828 b where c.id = b.fica;
