-- ROLLBACK de 20260922100100_confirmacao_processada_resolver (funcoes novas, somente leitura; nenhum dado tocado).
-- Ordem: antes de reverter esta migration, reverter 20260922100200 (que depende delas).
begin;
drop function if exists public.confirmacao_pagamento_processado(uuid);
drop function if exists public.confirmacao_pagamentos_resolver(uuid);
drop function if exists public.confirmacao_utc_provada(int);
drop function if exists public._nome_norm(text);
commit;
