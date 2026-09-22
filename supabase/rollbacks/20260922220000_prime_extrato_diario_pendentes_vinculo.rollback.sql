select cron.unschedule('prime_extrato_pendentes_vinculo_drenar');
select cron.unschedule('prime_extrato_pendentes_vinculo_enfileirar');
drop function if exists public.prime_extrato_reenfileirar_pendentes_vinculo();
