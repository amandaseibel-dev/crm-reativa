-- Rollback: volta a coleta Prime para uma vez por noite, 300 alunos.
--
-- Use se a Ulbra reclamar do volume, se aparecer 503 em série, ou se a
-- madrugada estiver pesando no banco. A coleta já feita permanece -- nada é
-- apagado, só o ritmo volta ao que era.

select cron.unschedule('prime_cadastro_mutirao')
where exists (select 1 from cron.job where jobname = 'prime_cadastro_mutirao');

select cron.schedule(
  'prime_cadastro_noturno',
  '10 6 * * *',
  $cron$ select public.prime_cadastro_disparar_noturno(300); $cron$
);

drop function if exists public.prime_cadastro_mutirao(integer);
