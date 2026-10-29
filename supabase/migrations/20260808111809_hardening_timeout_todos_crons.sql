-- Blindagem de TODOS os cron jobs: teto de tempo proprio por funcao (sem mudar logica).
-- Garante que nenhum cron corra solto e sature o banco. Reversivel com RESET statement_timeout.
-- Valores dimensionados ao tempo esperado de cada job, com folga.
--
-- Jobs cobertos (cron.job): 1 atualizar_parcelas_vencidas, 3 recalcular_situacao_virada_diaria,
-- 6 saude_carteira_atualizar, 7 saude_carteira_snapshot_gerar, 8 fidelizacao_liberar_vencidos,
-- 9 acoes_massivas (OFF), 10 retirar_zerados_reais, 11 vigia_carga.

alter function public.atualizar_parcelas_vencidas()                 set statement_timeout to '180s';
alter function public.recalcular_situacao_virada_diaria(text)       set statement_timeout to '240s';
alter function public.saude_carteira_atualizar()                    set statement_timeout to '180s';
alter function public.saude_carteira_snapshot_gerar()               set statement_timeout to '240s';
alter function public.liberar_casos_fidelizacao_vencida(integer)    set statement_timeout to '180s';
alter function public.retirar_zerados_reais_sem_saldo(uuid,integer) set statement_timeout to '180s';
alter function public.sistema_carga_vigia()                         set statement_timeout to '30s';
alter function public.acoes_massivas_executar_agendadas()           set statement_timeout to '120s';
