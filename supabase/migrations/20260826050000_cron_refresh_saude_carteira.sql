-- A Saúde da Carteira volta a acompanhar a realidade.
--
-- Medido em prod 2026-08-25. `saude_carteira_atualizar()` existe desde
-- 20260807260000 e o próprio comentário dela diz "cron 2h + sob demanda" --
-- mas NÃO HÁ NENHUM CRON chamando a função. Varrido `cron.job` inteiro: só
-- `saude_carteira_snapshot_diario` (08:05 UTC) e `atualizar_parcelas_vencidas`.
-- A matview só se atualiza quando alguém roda a função na mão.
--
-- O estrago é maior do que a tela. DOIS consumidores leem `mv_saude_carteira`:
--
--   1) `saude_carteira_resumo_impl`  -> a tela Saúde Completa da Carteira
--   2) `saude_carteira_snapshot_gerar` -> o HISTÓRICO diário
--
-- (a migration 20260804140000 no repositório diz que o snapshot lê a `vw`;
--  em produção a função foi trocada depois e lê a `mv`. O repositório está
--  desatualizado nesse ponto -- vale conferir ao mexer nela.)
--
-- Como o snapshot lê a cópia congelada, ele vinha ARQUIVANDO A MESMA FOTO
-- todo dia. Dos últimos 13 dias, 11 são repetição exata:
--
--   13/08 a 21/08  ->  14.631 casos / R$ 42.449.217,64  (9 dias idênticos)
--   22/08 a 25/08  ->  14.539 casos / R$ 43.468.870,10  (4 dias idênticos)
--
-- A série só se moveu em 13/08 e 22/08 -- os dias em que alguém rodou o
-- refresh na mão. Qualquer leitura de "evolução da carteira" tirada dali é
-- ficção. Em 25/08 o gap entre a foto e a base era de 48 casos e
-- R$ 851.972,25 -- baixas e vínculos feitos que não apareciam em lugar nenhum.
--
-- DOIS AGENDAMENTOS:
--   * de hora em hora -- a tela para de envelhecer sozinha;
--   * 07:50 UTC (04:50 BRT) -- 15 min antes do snapshot das 08:05 UTC, para a
--     foto do dia nascer de dado fresco. É redundante com o de hora em hora,
--     e a redundância é de propósito: se o das 08:00 for adiado pelo disjuntor,
--     o das 07:50 já garantiu o refresh. Um snapshot errado fica errado para
--     sempre; um refresh a mais custa segundos.
--
-- SEGURANÇA: `saude_carteira_atualizar()` já tem disjuntor (`sistema_sob_carga`)
-- e devolve `skipped` em vez de empilhar refresh sob carga. Skip é seguro --
-- a matview só defasa, nada corrompe. Duração medida hoje: 5,4s e 3,2s.
--
-- NÃO MEXE nos 11 snapshots já gravados errado. Apagá-los trocaria mentira por
-- buraco, e essa é uma decisão de negócio, não técnica.
--
-- Rollback: supabase/rollbacks/20260826050000_cron_refresh_saude_carteira.sql

select cron.unschedule(jobid) from cron.job where jobname in
  ('saude_carteira_refresh_horario','saude_carteira_refresh_pre_snapshot');

select cron.schedule(
  'saude_carteira_refresh_horario',
  '0 * * * *',
  $$ select public.saude_carteira_atualizar(); $$
);

select cron.schedule(
  'saude_carteira_refresh_pre_snapshot',
  '50 7 * * *',
  $$ select public.saude_carteira_atualizar(); $$
);
