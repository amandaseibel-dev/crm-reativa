-- Devolve a caixa-preta do webhook para 90 dias e junta o expurgo de volta no
-- job mensal. Atenção: a 90 dias a tabela projeta 2 GB, contra um banco de 1,4 GB.
create or replace function public.whatsapp_expurgar_eventos()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_qtd integer;
BEGIN
  DELETE FROM public.whatsapp_webhook_eventos WHERE recebido_em < now() - interval '90 days';
  GET DIAGNOSTICS v_qtd = ROW_COUNT;
  DELETE FROM public.whatsapp_conexao_eventos WHERE criado_em < now() - interval '90 days';
  RETURN v_qtd;
END;
$function$;

select cron.unschedule('whatsapp_expurgar_eventos_diario');
select cron.alter_job(
  (select jobid from cron.job where jobname = 'whatsapp_retencao_mensal'),
  command => E'\n        SELECT public.whatsapp_expurgar_retencao();\n        SELECT public.whatsapp_expurgar_eventos();\n      '
);
-- O que ja foi apagado nao volta. Os 48 eventos com erro estao em
-- _backup_webhook_com_erro_20260902.
