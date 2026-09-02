-- Volta o portador para a cadência original: a cada 3 minutos, o dia inteiro.
-- Atenção: são ~13 voltas completas por dia (~4.400 requisições à API do Prime)
-- para alimentar um relatório lido uma vez por dia.
select cron.alter_job(
  (select jobid from cron.job where jobname='prime_portador_mutirao'),
  schedule => '*/3 * * * *',
  active   => true
);
