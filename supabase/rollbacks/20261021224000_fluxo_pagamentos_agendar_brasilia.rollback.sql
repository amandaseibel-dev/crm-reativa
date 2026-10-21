-- ROLLBACK de 20261021224000_fluxo_pagamentos_agendar_brasilia.sql
--
-- DESAGENDA os três jobs da rodada incremental. A automação horária PARA.
--
-- O QUE ISTO NÃO FAZ:
--   * não desfaz nenhuma baixa já aplicada;
--   * não apaga a trilha de `fluxo_pagamentos_execucoes`;
--   * não remove a função nem a view;
--   * NÃO religa o job 38 -- ele continua `active = false`, como deve.
--
-- Depois de desagendar, a rodada continua existindo e pode ser chamada à mão
-- pela gestão. O que para é o disparo automático.
--
-- Conferir antes e depois:
--   select jobid, jobname, schedule, active from cron.job
--    where command ilike '%fluxo_pagamentos_incremental%';
--
-- ZERO DML nos dois sentidos.

select cron.unschedule('fluxo_pag_consolidado_08h_brt');
select cron.unschedule('fluxo_pag_horario_09_20h_brt');
select cron.unschedule('fluxo_pag_conferencia_noite_brt');
