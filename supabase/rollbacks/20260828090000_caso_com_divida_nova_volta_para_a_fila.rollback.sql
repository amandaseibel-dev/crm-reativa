select cron.unschedule('casos_reabrir_com_divida_horario');
drop function if exists public.casos_reabrir_com_divida(integer);

update public.casos c
   set status_atual = b.status_atual_antes,
       status_acionamento = b.status_acionamento_antes,
       status_jornada = b.status_jornada_antes,
       encerrado_operacional = true
  from public._backup_reabrir_com_divida_20260828 b
 where c.id = b.caso_id;
