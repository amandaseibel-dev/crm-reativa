-- Religa as duas rotinas de dívida do Prime.
-- Se for religar para valer, considere as cadências desenhadas em 02/09/2026 em
-- vez das originais: portador `0 1 * * *` e extrato `40 1 * * *`, ambos antes do
-- snapshot do relatório 2026/1 das 02:50. As originais (*/3 e */2, o dia todo)
-- faziam ~13 voltas diárias para um relatório lido uma vez por dia.
select cron.alter_job((select jobid from cron.job where jobname='prime_portador_mutirao'), active => true);
select cron.alter_job((select jobid from cron.job where jobname='prime_extrato_mutirao'),  active => true);
