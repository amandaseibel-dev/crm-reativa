-- ROLLBACK de 20260916230000_recuperacao_acordo_pago_sem_importacao.sql
--
-- EXECUTAVEL DE PONTA A PONTA. Derruba as tres funcoes; a migration nao criou
-- tabela, coluna, gatilho nem dado, entao nao ha mais nada a desfazer no
-- esquema.
--
-- O QUE ESTE ROLLBACK NAO FAZ, DE PROPOSITO: nao desfaz registro nenhum ja
-- confirmado. Acordo registrado pela gestao continua existindo -- ele representa
-- dinheiro que entrou e baixa que o motor fez. Para localizar cada um:
--
--   select registro_id as acordo_id, detalhes->>'pagamento_id' as pagamento_id,
--          detalhes->>'parcela_id' as parcela_id, detalhes->'titulo_ids' as titulos,
--          detalhes->>'confirmado_por' as confirmado_por, created_at
--     from public.auditoria
--    where acao = 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO'
--    order by created_at;
--
-- Desfazer um registro e decisao caso a caso, com o estado_antes da auditoria
-- em maos -- nunca em lote por este arquivo.

drop function if exists public.pagamentos_trava(uuid[]);
drop function if exists public.acordo_avista_registrar(uuid, uuid[], boolean);
drop function if exists public.acordo_avista_previa(uuid, uuid[]);
