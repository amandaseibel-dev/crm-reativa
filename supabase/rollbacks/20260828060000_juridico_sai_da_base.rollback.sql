drop trigger if exists trg_aluno_encerramento_propaga on public.alunos;
drop function if exists public.alunos_propaga_encerramento_para_caso();

update public.casos c
   set status_atual = b.caso_status_antes,
       encerrado_operacional = b.encerrado_antes
  from public._backup_juridico_sai_da_base_20260828 b
 where c.id = b.caso_id;
