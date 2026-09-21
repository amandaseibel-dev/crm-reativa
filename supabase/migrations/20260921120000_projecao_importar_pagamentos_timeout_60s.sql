-- IMPORTACAO DA PROJECAO: TIMEOUT PROPRIO DE 60s NA RPC
--
-- Incidente (21/09/2026 ~08:24 BRT): "Erro ao importar: canceling statement due to statement timeout".
-- O papel `authenticated` tem statement_timeout=8s e projecao_importar_pagamentos nao tinha teto
-- proprio. O INSERT em pagamentos dispara, na MESMA transacao, os gatilhos por linha
-- (_pagamento_conciliar -> pagamento_conciliar_um) e por comando (trg_pagamentos_gerar_confirmacao,
-- _pagamentos_baixar_lote -> baixa_pelo_relatorio_pagamento -> conciliacao_reprocessar). A tentativa
-- foi 100% revertida (0 importacao, 0 pagamento, 0 auditoria). Os `exception when others` do
-- _pagamentos_baixar_lote nao pegam QUERY_CANCELED, entao o timeout derruba o upload inteiro.
--
-- Alvo: SOMENTE a sobrecarga de 7 argumentos (a que a tela chama):
--   projecao_importar_pagamentos(text,text,jsonb,text,boolean,uuid,text)
--   md5(pg_get_functiondef) antes = 7ec234634c69e86fa74fefea250c2d9f
--   md5(prosrc)             antes = a0880e5367d19e0a02ef9f71c9447860 (nao muda)
--   proconfig antes = {search_path=public}; SECURITY DEFINER; owner postgres;
--   acl = {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
-- A sobrecarga antiga de 4 argumentos NAO e tocada.
--
-- MUDANCA: ALTER FUNCTION ... SET statement_timeout = '60s'. Corpo, assinatura, owner, GRANTs,
-- SECURITY DEFINER e search_path ficam como estao. Nao altera o timeout de authenticated/authenticator,
-- nenhum gatilho, nenhuma regra, nenhum dado. Continua UMA transacao com rollback integral; o
-- ON CONFLICT e a trava de duplicidade seguem identicos.
-- Precedente no repo: baixar_parcela_acordo / cancelar_acordo_ficha (60s), importar_acordos (180s).
-- Rollback: supabase/rollbacks/20260921120000_projecao_importar_pagamentos_timeout_60s.rollback.sql
begin;

ALTER FUNCTION public.projecao_importar_pagamentos(text, text, jsonb, text, boolean, uuid, text)
  SET statement_timeout = '60s';

commit;
