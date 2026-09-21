-- D-2: agendamento DIARIO de acordo_alertas_gerar. Apenas INSTALA o job; nao executa a funcao, nao cria alertas.
--
-- Horario: 08:30 de Brasilia = 11:30 UTC. Conferido em producao: cron.timezone = GMT (default) e TimeZone = UTC, e as ultimas execucoes dos jobs
-- diarios existentes batem com o horario UTC do schedule. Brasilia esta em UTC-3 o ano todo (sem horario de verao desde 2019), entao a
-- expressao fixa '30 11 * * *' equivale a 08:30 America/Sao_Paulo. Os operadores comecam as 09:00: os alertas do dia ja estao disponiveis.
-- Regra D-2 exata (PR #445): a funcao gera so quando hoje = vencimento - 2 dias corridos; rodada perdida nao e recuperada depois.
-- Idempotente: cron.schedule com jobname existente ATUALIZA o job (pg_cron >= 1.3), nunca duplica. Nome unico: acordo_alertas_d2_diario.
-- Chama SOMENTE public.acordo_alertas_gerar(). Nao toca confirmacao de pagamentos, flag encerrar_confirmacao_processada, backfill, saldo.
select cron.schedule('acordo_alertas_d2_diario', '30 11 * * *',
  $cron$select public.acordo_alertas_gerar();$cron$);
