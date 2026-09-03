-- Rollback de 20260902400000_calibragem_valor_manda_e_desfazer.
--
-- ATENCAO: volta a simulacao ao comportamento em que a fase 1 escolhe cego ao
-- valor e a fase 3 aborta no primeiro par ruim -- ou seja, o equilibrio de
-- valor deixa de acontecer de novo. Use so se a versao nova causar problema.
--
-- O QUE ESTE ROLLBACK NAO DESFAZ (de proposito):
--   - simulacoes que ja foram REVERTIDAS: os casos ja voltaram para os donos
--     anteriores e a auditoria registrou. Reverter a reversao seria um novo
--     nivelamento, nao um rollback de migration.
--   - o status EXECUTADA das simulacoes que estavam presas em EXECUTANDO: elas
--     estavam de fato aplicadas; o status so passou a dizer a verdade.

-- 1. Desfazer: remove as funcoes novas. Se houver simulacao em DESFAZENDO,
--    conclua a reversao ANTES de rodar isto -- senao ela fica sem executor.
drop function if exists public.calibragem_desfazer_nivelamento_lote(uuid, integer);
drop function if exists public.calibragem_desfazer_nivelamento_lote_impl(uuid, integer);

-- 2. Status: volta ao conjunto antigo. Só passa se nao houver linha em
--    DESFAZENDO/REVERTIDA -- por isso o UPDATE antes.
update public.calibragem_simulacoes set status='EXECUTADA' where status in ('DESFAZENDO','REVERTIDA');
alter table public.calibragem_simulacoes
  drop constraint if exists calibragem_simulacoes_status_check;
alter table public.calibragem_simulacoes
  add constraint calibragem_simulacoes_status_check
  check (status = any (array['RASCUNHO','APROVADA','EXECUTANDO','EXECUTADA','DESCARTADA']));

-- 3. Motor e executor: restaure as versoes anteriores aplicando, nesta ordem,
--    o corpo que estava em producao antes desta migration:
--      supabase/migrations/20260820120000_calibragem_nivelamento_ano_recente_e_alvo_medio.sql
--        (fase 1 por `venc_min asc, valor asc`, fase 3 com `exit` no overshoot)
--      + o wrapper `exigir_capacidade` e o piso `greatest(v_dias,10)`, que
--        vieram depois e NAO devem ser perdidos.
--    Nao ha DROP aqui: `calibragem_simular_nivelamento_impl` e
--    `calibragem_executar_nivelamento_lote_impl` sao CREATE OR REPLACE e
--    derrubar as duas deixaria a tela sem motor nenhum.
