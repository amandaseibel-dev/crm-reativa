-- Para o automatismo. Vinculos ja feitos permanecem (auditoria SUGESTAO_VINCULO_AUTOMATICO identifica cada um).
select cron.unschedule('acordo_vinculo_automatico');
drop function if exists public.acordo_vinculo_automatico_processar(int);
