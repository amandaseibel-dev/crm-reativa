-- ROLLBACK de 20261021195950_fluxo_pagamentos_incremental.sql
--
-- O QUE FAZ:     apaga a função `fluxo_pagamentos_incremental` e a view
--                `vw_fluxo_pagamentos_monitor`.
-- O QUE NÃO FAZ: não desfaz nenhuma baixa, não reabre pagamento, não apaga
--                linha de `fluxo_pagamentos_execucoes` nem de
--                `fila_pagamento_sem_vinculo`.
--
-- A TRILHA FICA DE PROPÓSITO. As execuções registradas são o histórico de
-- monitoramento; apagá-las esconderia o que a rodada fez. Depois deste
-- rollback as linhas continuam legíveis direto em
-- `public.fluxo_pagamentos_execucoes where origem = 'incremental'`.
--
-- SE A RODADA JÁ ESTIVER AGENDADA NO CRON, em letras maiúsculas:
--
--   DESAGENDE O JOB ANTES DE APAGAR A FUNÇÃO. Um job apontando para função
--   inexistente falha a cada hora e polui cron.job_run_details.
--
--   select jobid, jobname from cron.job where command ilike '%fluxo_pagamentos_incremental%';
--   -- e então, com autorização: select cron.unschedule(<jobid>);
--
-- ZERO DML sobre pagamentos, acordos, parcelas ou alunos nos dois sentidos.

drop view if exists public.vw_fluxo_pagamentos_monitor;
drop function if exists public.fluxo_pagamentos_incremental(int,int,int,int,boolean);
