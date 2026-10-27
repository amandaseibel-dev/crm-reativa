begin;

revoke execute on function public._caso_sem_saldo_conferido(uuid, text)
  from public, anon;
revoke execute on function public._caso_encerrado_operacional_regra(uuid, uuid, text, text, text, text, text)
  from public, anon;
revoke execute on function public._encerramento_congelado(uuid, uuid, text, text, text, text, text)
  from public, anon;
revoke execute on function public.caso_encerrado_operacional(uuid, uuid, text, text, text, text, text)
  from public, anon;
revoke execute on function public.caso_encerramento_congelado(uuid)
  from public, anon;

commit;
