-- Devolve o mutirão cadastral do Prime para a cada dois minutos, todo dia.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'prime_cadastro_mutirao'),
  schedule => '*/2 * * * *'
);
