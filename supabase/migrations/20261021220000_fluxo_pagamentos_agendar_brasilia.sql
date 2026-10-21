-- ⚠️  ESTA MIGRATION ATIVA A AUTOMAÇÃO. APLICAR SÓ COM AUTORIZAÇÃO EXPRESSA.
--
-- Agenda três jobs de pg_cron para a rodada incremental, nas janelas de
-- Brasília decididas pela gestão em 21/10/2026. Zero DML, nenhuma função
-- criada ou alterada: só `cron.schedule`.
--
-- NÃO TOCA NO JOB 38. O `fluxo_pagamentos_horario` antigo, que derrubou o banco
-- em 24/09, continua `active = false` e não é religado nem removido. Esta
-- migration RECUSA aplicar se ele estiver ativo, para que os dois nunca corram
-- juntos.
--
-- ===========================================================================
-- O FUSO: cron.timezone = 'GMT'. TUDO AQUI ESTÁ EM UTC.
-- ===========================================================================
--
-- Medido em 21/10/2026: `cron.timezone` = GMT e o banco em UTC. pg_cron NÃO
-- aceita fuso por job nesta instância, então a conversão é feita à mão.
-- Brasília é UTC-3 fixo (horário de verão extinto em 2019), logo UTC = BRT + 3.
--
--   janela pedida (Brasília)   | cron (UTC)        | dispara (Brasília)
--   ---------------------------|-------------------|----------------------------
--   08:00 consolidado          | 0 11 * * *        | 08:00
--   09:00-20:00 a cada hora    | 0 12-23 * * *     | 09:00 ... 20:00
--   20:01-23:59 conferência    | 30 23,0,1,2 * * * | 20:30, 21:30, 22:30, 23:30
--   00:00-07:59 acumula        | (nada agendado)   | --
--
-- A faixa UTC 03:00-10:59 fica deliberadamente vazia: é a madrugada de
-- Brasília. "Acumular" é simplesmente não rodar -- a fila é derivada do estado,
-- então o pagamento que entrar às 02h aparece na primeira rodada das 08h, sem
-- fila própria e sem risco de perder nada.
--
-- ===========================================================================
-- A JANELA DA NOITE NÃO BAIXA -- é conferência, por decisão da gestão
-- ===========================================================================
--
-- O job das 20:30 às 23:30 chama a função com `p_aplicar => false`. Isso NÃO é
-- uma promessa de comportamento: desde a 20261021210416 a prévia roda o motor
-- em subtransação SEMPRE revertida, então nenhuma escrita dele, de gatilho ou
-- de efeito indireto persiste -- só o registro de monitoramento. Foi provado em
-- produção em 21/10: oito tabelas financeiras com digital de linha inteira
-- idêntica antes e depois, e o contador de tentativas sequer avançou.
--
-- Para a noite passar a baixar, troque `false` por `true` NESTE job -- com
-- autorização específica, que a gestão reservou.
--
-- ===========================================================================
-- OS PARÂMETROS: (p_lote, p_segundos, p_tentativas_max, p_espera_horas, p_aplicar)
-- ===========================================================================
--
--   p_lote = 25           teto por rodada, como a gestão fixou. Vazão: 386
--                         pendentes e 17 disparos/dia dão 425 avaliações/dia,
--                         pouco mais de uma por pendente.
--   p_segundos = 20       orçamento normal; 45 no consolidado das 08h, que
--                         enfrenta o acumulado da noite. O teto duro da função
--                         é 120s, e ela confere o prazo a CADA pagamento.
--   p_tentativas_max = 8  a partir daí o pendente é DESPRIORIZADO (vai para o
--   p_espera_horas = 24   fim da fila), nunca excluído -- ver 20261021215000.
--
-- As demais proteções já estão na função e não dependem do agendamento: trava
-- `pg_try_advisory_xact_lock` (rodada ocupada sai, não enfileira), guarda
-- `sistema_sob_carga()`, e a fronteira de 14/09 que mantém os 8.955 pagamentos
-- anteriores invisíveis para o automático.
--
-- REGRAS FINANCEIRAS PRESERVADAS: nada aqui altera o motor. Quem decide se
-- baixa, e com que evidência, continua sendo `pagamento_conciliar_um`.
--
-- Reversível: supabase/rollbacks/20261021220000_*.rollback.sql

-- Guarda: os dois agendamentos nunca coexistem.
do $$
begin
  if exists (select 1 from cron.job where jobid = 38 and active) then
    raise exception
      'RECUSADO: o job 38 (fluxo_pagamentos_horario) esta ATIVO. Ele derrubou o banco em 24/09/2026 e precisa continuar desligado antes de agendar a rodada incremental. Os dois nunca devem correr juntos.';
  end if;
  if exists (select 1 from cron.job where command ilike '%fluxo_pagamentos_incremental%') then
    raise exception
      'RECUSADO: ja existe job agendado para fluxo_pagamentos_incremental. Conferir com: select jobid, jobname, schedule, active from cron.job where command ilike ''%%fluxo_pagamentos_incremental%%'';';
  end if;
end $$;

-- 08:00 de Brasília -- consolidado do que acumulou das 00:00 às 07:59.
select cron.schedule(
  'fluxo_pag_consolidado_08h_brt',
  '0 11 * * *',
  $$select public.fluxo_pagamentos_incremental(25, 45, 8, 24, true)$$
);

-- 09:00 às 20:00 de Brasília -- a cada hora.
select cron.schedule(
  'fluxo_pag_horario_09_20h_brt',
  '0 12-23 * * *',
  $$select public.fluxo_pagamentos_incremental(25, 20, 8, 24, true)$$
);

-- 20:30 às 23:30 de Brasília -- CONFERÊNCIA, sem baixa (p_aplicar => false).
select cron.schedule(
  'fluxo_pag_conferencia_noite_brt',
  '30 23,0,1,2 * * *',
  $$select public.fluxo_pagamentos_incremental(25, 20, 8, 24, false)$$
);
