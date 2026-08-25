-- Rollback de 20260825140000_confirmacao_origem_divida.sql
-- Remove o carimbo de origem da dívida. Não mexe em status, valores nem filas.
drop trigger if exists trg_confirmacao_origem_divida on public.solicitacoes_confirmacao_pagamento;
drop function if exists public.tg_confirmacao_origem_divida();
drop function if exists public.recarimbar_origem_divida_pendentes(int);
drop function if exists public.crm_origem_divida_solicitacao(text, text);
drop function if exists public.crm_origem_divida_do_aluno(uuid);
drop index if exists public.idx_solic_conf_origem_divida_aberta;
alter table public.solicitacoes_confirmacao_pagamento
  drop constraint if exists solic_conf_pagto_origem_divida_chk;
alter table public.solicitacoes_confirmacao_pagamento
  drop column if exists origem_divida;
