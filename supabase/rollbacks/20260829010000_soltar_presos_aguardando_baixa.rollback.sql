update public.alunos al
   set status_atual = b.status_anterior,
       status_jornada = b.status_jornada_anterior
  from public._backup_presos_aguardando_baixa_20260829 b
 where al.id = b.aluno_id;
