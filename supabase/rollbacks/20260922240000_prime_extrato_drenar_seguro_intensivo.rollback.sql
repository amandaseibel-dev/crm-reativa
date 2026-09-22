select cron.unschedule('prime_extrato_pendentes_vinculo_intensivo');
select cron.schedule('prime_extrato_pendentes_vinculo_drenar', '15,35,55 3 * * *',
  $cron$select public.prime_extrato_mutirao();$cron$);
drop function if exists public.prime_extrato_drenar_seguro();
