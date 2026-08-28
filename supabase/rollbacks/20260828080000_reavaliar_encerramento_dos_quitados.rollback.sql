select cron.unschedule('casos_reavaliar_encerramento_horario');
drop function if exists public.casos_reavaliar_encerramento(integer);

update public.casos
   set encerrado_operacional = false
 where caso_atualizado_por = 'sistema_reavaliar_encerramento';
