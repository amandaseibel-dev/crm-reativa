-- Rollback de 20260826050000_cron_refresh_saude_carteira.sql
--
-- Remove os dois agendamentos. A matview volta a só ser atualizada quando
-- alguém rodar `saude_carteira_atualizar()` na mão -- e o snapshot diário volta
-- a arquivar a mesma foto todo dia, porque ele lê a matview.
--
-- Só reverta se o refresh de hora em hora estiver pesando na base. Nesse caso,
-- prefira ESPAÇAR (de 2 em 2 horas, '0 */2 * * *') em vez de remover, e mantenha
-- o `saude_carteira_refresh_pre_snapshot` -- é ele que garante que o histórico
-- do dia nasça de dado fresco.

select cron.unschedule(jobid) from cron.job where jobname in
  ('saude_carteira_refresh_horario','saude_carteira_refresh_pre_snapshot');
