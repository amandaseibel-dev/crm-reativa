-- Para o automatismo. Confirmacoes ja feitas permanecem (auditoria FILA_ACORDO_CONFIRMADO_AUTOMATICO identifica cada uma).
select cron.unschedule('fila_acordos_confirmar_automatico');
drop function if exists public.fila_acordos_confirmar_automatico(int);
